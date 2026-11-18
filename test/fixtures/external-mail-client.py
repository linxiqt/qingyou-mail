"""Interoperability checks with three independent standard-library clients."""
import email
from email.message import EmailMessage
from email.policy import default
import imaplib
import json
import poplib
import smtplib
import socket
import ssl
import sqlite3
import sys

cfg = json.load(sys.stdin)
host = "127.0.0.1"
context = ssl.create_default_context(cafile=cfg["ca"])
alice, bob = "alice@example.test", "bob@example.test"
password = "Local-protocol-fixture-2026!"
def pop(user=bob):
    client = poplib.POP3_SSL(host, cfg["pop3s"], timeout=8, context=context)
    client.user(user)
    client.pass_(password)
    return client
def imap(user=bob):
    client = imaplib.IMAP4_SSL(host, cfg["imaps"], ssl_context=context, timeout=8)
    client.login(user, password)
    return client
def ok(result):
    assert result[0] == "OK", result
    return result[1]
def fails(action, error):
    try:
        action()
    except error:
        return
    raise AssertionError("expected refusal")

if cfg.get("verifyRestart"):
    p = pop()
    assert p.uidl(1).decode().endswith(cfg["popUid"])
    p.quit()
    with imap() as c:
        ok(c.select("INBOX"))
        assert ok(c.uid("SEARCH", None, "ALL")) == [cfg["imapUid"].encode()]
        assert c.response("UIDVALIDITY")[1][0].decode() == cfg["validity"]
    p = pop()
    p.dele(1)
    p.quit()
    with imap() as c:
        assert ok(c.select("INBOX")) == [b"0"]
        assert ok(c.select("Trash")) == [b"1"]
    print(json.dumps({"restart": True}))
    sys.exit()

domain_context = ssl.create_default_context(cafile=cfg["domainCa"])
for protocol, greeting in (("imaps", b"* OK"), ("smtps", b"220"), ("pop3s", b"+OK")):
    with socket.create_connection((host, cfg[protocol]), timeout=8) as tcp:
        with domain_context.wrap_socket(tcp, server_hostname="mail.example.test") as secure:
            assert secure.recv(1024).startswith(greeting), protocol
    with socket.create_connection((host, cfg[protocol]), timeout=8) as tcp:
        with context.wrap_socket(tcp, server_hostname="localhost") as secure:
            assert secure.recv(1024).startswith(greeting), protocol
with smtplib.SMTP(host, cfg["submission"], timeout=8) as submission:
    submission._host = "mail.example.test"  # Dial loopback, send the DNS name as SNI.
    assert submission.starttls(context=domain_context)[0] == 220
    assert submission.ehlo()[0] == 250

with smtplib.SMTP_SSL(host, cfg["smtps"], context=context, timeout=8) as sender:
    fails(lambda: sender.login(alice, "wrong-password"), smtplib.SMTPAuthenticationError)
    fails(lambda: sender.login("admin", password), smtplib.SMTPAuthenticationError)
    sender.login(alice.upper(), password)
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = alice, bob, "第三方客户端验收"
    msg.set_content("first line\n.line with dot\nlast line")
    msg.add_attachment(bytes(range(256)), maintype="application", subtype="octet-stream", filename="sample.bin")
    if cfg.get("locked"):
        fails(lambda: sender.send_message(msg), smtplib.SMTPResponseException)
    else:
        fails(lambda: sender.sendmail(bob, [alice], msg.as_bytes()), smtplib.SMTPSenderRefused)
        sender.send_message(msg)

test_pop = poplib.POP3_SSL(host, cfg["pop3s"], timeout=8, context=context)
test_pop.user(bob)
fails(lambda: test_pop.pass_("wrong-password"), poplib.error_proto)
test_pop.quit()
p = pop()
assert p.stat()[0] == 1
pop_uid = p.uidl(1).split()[-1].decode()
message = b"\r\n".join(p.retr(1)[1]) + b"\r\n"
assert p.stat()[1] == len(message)
assert b".line with dot\r\n" in message
assert b"MIME-Version:" in b"\n".join(p.top(1, 0)[1])
p.dele(1)
p.close()  # Abandon the session: deletion must roll back.
p = pop()
assert p.uidl(1).decode().endswith(pop_uid)
p.dele(1)
p.rset()
p.quit()

with imaplib.IMAP4_SSL(host, cfg["imaps"], ssl_context=context, timeout=8) as bad:
    fails(lambda: bad.login(bob, "incorrect"), imaplib.IMAP4.error)
with imap(alice) as a:
    assert ok(a.select("INBOX")) == [b"0"], "other user's mail leaked"
    if not cfg.get("locked"):
        assert ok(a.select("Sent")) == [b"1"]
with imap() as c:
    assert len(ok(c.list())) == 6
    assert ok(c.select("INBOX")) == [b"1"]
    validity = c.response("UIDVALIDITY")[1][0].decode()
    imap_uid = ok(c.uid("SEARCH", None, "ALL"))[0].decode()
    records = ok(c.uid("FETCH", imap_uid, "(UID BODY.PEEK[])"))
    assert records[0][1].rstrip(b"\r\n") == message.rstrip(b"\r\n")
    parsed = email.message_from_bytes(records[0][1], policy=default)
    assert parsed.get_body().get_content().splitlines()[1] == ".line with dot"
    if not cfg.get("locked"):
        assert next(parsed.iter_attachments()).get_payload(decode=True) == bytes(range(256))
        ok(c.uid("FETCH", imap_uid, "(BODYSTRUCTURE)"))
        encoded = ok(c.uid("FETCH", imap_uid, "(BODY.PEEK[2])"))[0][1]
        import base64
        assert base64.b64decode(encoded) == bytes(range(256))
        ok(c.uid("STORE", imap_uid, "+FLAGS", r"(\Seen \Flagged)"))
        ok(c.uid("COPY", imap_uid, "Archive"))
        assert ok(c.select("Archive")) == [b"1"]
        ok(c.store("1", "+FLAGS", r"(\Deleted)"))
        ok(c.expunge())
        ok(c.append("Drafts", r"(\Draft)", None, msg.as_bytes()))
    else:
        assert c.append("Drafts", r"(\Draft)", None, msg.as_bytes())[0] == "NO"

# Revoke access with a client already logged in; reads must recheck.
db = sqlite3.connect(cfg["database"])
try:
    with imap() as c:
        ok(c.select("INBOX"))
        db.execute("UPDATE domains SET enabled=0 WHERE name='example.test'")
        db.commit()
        assert c.uid("FETCH", imap_uid, "(BODY.PEEK[])")[0] == "NO"
finally:
    db.execute("UPDATE domains SET enabled=1 WHERE name='example.test'")
    db.commit()
# The same stored password is used for all three protocols and current sessions
# must observe changed credentials and personal permissions before accessing mail.
with imap() as c:
    ok(c.select("INBOX"))
    old_hash = db.execute("SELECT password_hash FROM users WHERE email=?", (bob,)).fetchone()[0]
    db.execute("UPDATE users SET password_hash='revoked-test-hash' WHERE email=?", (bob,))
    db.commit()
    assert c.uid("FETCH", imap_uid, "(BODY.PEEK[])")[0] == "NO"
    db.execute("UPDATE users SET password_hash=? WHERE email=?", (old_hash, bob))
    db.commit()
db.execute("UPDATE users SET client_manager=1,admin_capabilities=? WHERE email=?", ('["mail.read"]',bob))
db.commit()
with imap() as c:
    ok(c.select("INBOX"))
    assert c.uid("STORE", imap_uid, "+FLAGS", r"(\Deleted)")[0] == "NO"
restricted = pop()
fails(lambda: restricted.dele(1), poplib.error_proto)
restricted.quit()
db.execute("UPDATE users SET client_manager=0,admin_capabilities=NULL WHERE email=?", (bob,))
db.commit()
db.close()
print(json.dumps({"popUid": pop_uid, "imapUid": imap_uid, "validity": validity}))
