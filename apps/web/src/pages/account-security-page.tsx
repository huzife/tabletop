import { ArrowLeft, CheckCircle2, KeyRound, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Button, TextField } from "@tabletop/ui";
import { useAuth } from "../auth";
import { ApiClientError } from "../api/client";

export function AccountSecurityPage() {
  const { changePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const mismatch = Boolean(confirmation && newPassword !== confirmation);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mismatch || newPassword.length < 6) return;
    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setMessage("密码已修改，其他设备的会话已注销");
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : "密码修改失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page page--narrow">
      <Link className="back-link" to="/">
        <ArrowLeft size={16} /> 返回首页
      </Link>
      <header className="page-heading">
        <span className="eyebrow">账户</span>
        <h1>安全设置</h1>
        <p>修改密码后，其他设备上的登录会话将被注销。</p>
      </header>
      <section aria-labelledby="change-password-title" className="settings-section">
        <div className="section-heading">
          <div>
            <h2 id="change-password-title">修改密码</h2>
            <p>新密码至少包含 6 个字符。</p>
          </div>
          <KeyRound size={21} />
        </div>
        {message ? (
          <div className="success-notice" role="status">
            <CheckCircle2 size={18} /> {message}
          </div>
        ) : null}
        {error ? (
          <div className="warning-notice" role="alert">
            {error}
          </div>
        ) : null}
        <form className="form-stack form-stack--compact" onSubmit={handleSubmit}>
          <TextField
            autoComplete="current-password"
            label="当前密码"
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
            type="password"
            value={currentPassword}
          />
          <TextField
            autoComplete="new-password"
            error={
              newPassword.length > 0 && newPassword.length < 6 ? "至少需要 6 个字符" : undefined
            }
            label="新密码"
            minLength={6}
            onChange={(event) => setNewPassword(event.target.value)}
            required
            type="password"
            value={newPassword}
          />
          <TextField
            autoComplete="new-password"
            error={mismatch ? "两次输入的密码不一致" : undefined}
            label="确认新密码"
            onChange={(event) => setConfirmation(event.target.value)}
            required
            type="password"
            value={confirmation}
          />
          <div className="form-actions">
            <Button disabled={mismatch || newPassword.length < 6 || submitting} type="submit">
              <Save size={17} /> 保存密码
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
