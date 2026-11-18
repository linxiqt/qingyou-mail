(() => {
  const w = MailWorkspace;
  const requireGlobal = () => {
    if (!w.isGlobal()) throw new Error("仅全局管理员可管理授权");
  };
  const date = (value) =>
    value
      ? new Date(
          typeof value === "number" ? value * 1000 : value,
        ).toLocaleString("zh-CN")
      : "—";
  w.pages.license = async () => {
    requireGlobal();
    const data = await w.h.api("/admin/license");
    w.h.state.license = data;
    return (
      w.title("程序授权", "在原有 KeyDock 授权站管理授权码、设备与离线文件。") +
      `<section class="card form-card"><h2>${w.e(data.valid ? (data.mode === "offline" ? "离线授权有效" : "在线授权有效") : "等待激活或恢复授权")}</h2>` +
      w.note(
        data.required
          ? data.reason ||
              "每 60 秒检查授权状态，固定 IP 每 14 天重新完整验证。"
          : "当前为维护源码版，未强制启用商业授权。",
      ) +
      `<dl class="license-details"><dt>程序 ID</dt><dd><code>${w.e(data.productId || "未绑定")}</code></dd><dt>设备 ID</dt><dd><code>${w.e(data.deviceId || "—")}</code></dd><dt>授权码</dt><dd>${w.e(data.keyHint || "未激活")}</dd><dt>到期时间</dt><dd>${data.forever ? "永久（在线）" : date(data.expiresAt)}</dd><dt>最近检查</dt><dd>${date(data.lastCheckAt)}</dd><dt>离线文件到期</dt><dd>${date(data.offlineExpiresAt)}</dd></dl>` +
      `<div class="row-actions"><a class="btn secondary" href="https://authorize.lxya.cc/" target="_blank" rel="noopener noreferrer">前往授权站</a>${w.button("重新校验", "license-verify")}${w.button("复制设备 ID", "license-device", `data-device="${w.e(data.deviceId)}"`)}</div></section>` +
      `<section class="card form-card"><h2>激活 / 更换授权码</h2><form data-m-form="license-activate">${w.input("key", "完整授权码", "", "password", 'required maxlength="128" autocomplete="off" placeholder="KD-…"')}<button class="btn" type="submit">验证并激活</button></form></section>` +
      `<section class="card form-card"><h2>离线授权文件</h2><p class="hint">从原授权站签发 JSON 文件后导入。在线时保存备用，授权站不可连接时启用；明确停用、到期或证书错误不会被离线文件绕过。普通用户最多 14 天，授权站管理员最多 365 天。</p><form data-m-form="license-offline"><div class="field"><label>选择离线授权文件<input type="file" name="grant" accept=".json,application/json" required></label></div><button class="btn secondary" type="submit">验证并导入</button></form><p class="hint">未授权时保留入站收件，暂停发件及后台业务。请备份 data/license 以保留设备身份；迁移到新的安装应先在授权站解绑原设备。</p></section>`
    );
  };
  w.pages["service-unavailable"] = async () =>
    w.title(
      "服务待恢复",
      "后台功能暂时不可用，请联系全局管理员恢复程序授权。",
    ) +
    `<section class="card form-card">${w.note("已收到的邮件会保留，入站收件继续运行。恢复后可重新进入管理工作台。")}${w.button("重新检查服务", "license-state-refresh")}</section>`;
  const update = async (result) => {
    w.h.state.license = result;
    await w.loadPreferences();
    w.h.shell();
    await w.h.render();
  };
  w.forms["license-activate"] = async (data) => {
    requireGlobal();
    await update(
      await w.h.api("/admin/license/activate", {
        method: "POST",
        body: { key: data.key },
      }),
    );
    w.h.toast("授权已激活");
  };
  w.forms["license-offline"] = async (_data, form) => {
    requireGlobal();
    const file = form.elements.namedItem("grant").files[0];
    if (!file || file.size > 16384)
      throw new Error("请选择不超过 16 KB 的 JSON 授权文件");
    const result = await w.h.api("/admin/license/offline", {
      method: "POST",
      body: { file: await file.text() },
    });
    await update(result);
    w.h.toast(
      result.valid
        ? "离线文件已保存，当前授权有效"
        : "文件已保存，请检查当前授权状态",
    );
  };
  w.actions["license-verify"] = async () => {
    requireGlobal();
    await update(
      await w.h.api("/admin/license/verify", { method: "POST", body: {} }),
    );
  };
  w.actions["license-device"] = (node) => {
    requireGlobal();
    return w.h.copy(node.dataset.device);
  };
  w.actions["license-state-refresh"] = async () => {
    const result = await w.h.api("/auth/me");
    await update(result.license);
    if (result.license?.valid) location.hash = w.defaultRoute();
  };
})();
