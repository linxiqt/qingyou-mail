"""Actual plain IMAP/SMTP interoperability against an isolated loopback fixture."""
import imaplib
import json
import smtplib
import sys
from email.message import EmailMessage

cfg = json.load(sys.stdin)
host = "127.0.0.1"
email, other, password = cfg["address"], cfg["other"], cfg["password"]


def refused(action, kind):
    try:
        action()
    except kind:
        return
    raise AssertionError("unexpected successful authentication or delivery")


with smtplib.SMTP(host, cfg["smtp"], timeout=6) as smtp:
    assert smtp.ehlo()[0] == 250
    if cfg.get("disabled"):
        assert not smtp.has_extn("auth")
        print(json.dumps({"disabled": True}))
        sys.exit()
    assert smtp.has_extn("auth")
    assert smtp.mail("sender@elsewhere.test")[0] == 250
    assert smtp.rcpt("thirdparty@external.test")[0] == 550
    assert smtp.rset()[0] == 250
    assert smtp.mail("worker@example.test")[0] == 553
    refused(lambda: smtp.login(other, password), smtplib.SMTPAuthenticationError)

with imaplib.IMAP4(host, cfg["imap"], timeout=6) as imap:
    refused(lambda: imap.login(other, password), imaplib.IMAP4.error)
    refused(lambda: imap.login(email, "wrong-password"), imaplib.IMAP4.error)
    assert imap.login(email.upper(), password)[0] == "OK"
    assert imap.select("INBOX", readonly=True) == ("OK", [b"1"])
    status, data = imap.fetch("1", "(BODY.PEEK[])")
    assert status == "OK" and b"visible fixture" in data[0][1]

with smtplib.SMTP(host, cfg["smtp"], timeout=6) as smtp:
    assert smtp.login(email, password)[0] == 235
    if cfg["locked"]:
        assert smtp.mail(email)[0] >= 400
    else:
        assert smtp.mail(other)[0] == 553
        assert smtp.rset()[0] == 250
        msg = EmailMessage()
        msg["From"], msg["To"], msg["Subject"] = email, email, "round trip"
        msg.set_content("local delivery over the MX port")
        assert smtp.send_message(msg) == {}
        with imaplib.IMAP4(host, cfg["imap"], timeout=6) as imap:
            assert imap.login(email, password)[0] == "OK"
            assert imap.select("INBOX", readonly=True) == ("OK", [b"2"])
            assert imap.select("Sent", readonly=True) == ("OK", [b"1"])

print(json.dumps({"verified": True}))
