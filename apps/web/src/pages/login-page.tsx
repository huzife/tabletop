import { Gamepad2, KeyRound, LogIn, UserRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { Button, TextField } from "@tabletop/ui";
import { useAuth } from "../auth";
import { ApiClientError } from "../api/client";

interface LoginLocationState {
  returnTo?: string;
}

export function LoginPage() {
  const { signIn } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await signIn(username, password);
      const state = location.state as LoginLocationState | null;
      navigate(state?.returnTo ?? "/", { replace: true });
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : "暂时无法登录，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <section aria-labelledby="login-title" className="login-panel">
        <div className="login-brand">
          <span className="brand__mark brand__mark--large">
            <Gamepad2 size={28} strokeWidth={2.2} />
          </span>
          <span>Tabletop</span>
        </div>
        <div className="login-heading">
          <span className="eyebrow">受限访问</span>
          <h1 id="login-title">登录游戏桌</h1>
          <p>使用管理员为你创建的账号继续。</p>
        </div>
        <form className="form-stack" onSubmit={handleSubmit}>
          <div className="input-with-icon">
            <UserRound aria-hidden="true" size={18} />
            <TextField
              autoComplete="username"
              label="用户名"
              onChange={(event) => setUsername(event.target.value)}
              required
              value={username}
            />
          </div>
          <div className="input-with-icon">
            <KeyRound aria-hidden="true" size={18} />
            <TextField
              autoComplete="current-password"
              error={error || undefined}
              label="密码"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </div>
          <Button className="button-wide" disabled={submitting} type="submit">
            <LogIn size={18} />
            {submitting ? "登录中" : "登录"}
          </Button>
        </form>
      </section>
    </main>
  );
}
