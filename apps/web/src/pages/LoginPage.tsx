import { useState } from "react";
import { useAppStore } from "../stores/AppStore.tsx";

const MIN_PIN_LENGTH = 4;

export function LoginPage() {
  const { login, error } = useAppStore();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy || pin.length < MIN_PIN_LENGTH) return;
    setBusy(true);
    try {
      await login(pin);
    } finally {
      setBusy(false);
      setPin("");
    }
  };

  return (
    <div className="login">
      <div className="login-card">
        <h1>CMUX Agent Remote</h1>
        <p className="login-hint">输入启动服务时打印的 Access PIN</p>
        <input
          className="login-input pin-input"
          value={pin}
          autoFocus
          type="password"
          // 手机上直接弹数字键盘
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          maxLength={12}
          placeholder="••••"
          onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 12))}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
        />
        <button
          type="button"
          className="primary-button"
          disabled={busy || pin.length < MIN_PIN_LENGTH}
          onClick={() => void submit()}
        >
          {busy ? "登录中…" : "登录"}
        </button>
        {error ? <div className="login-error">{error}</div> : null}
        <p className="login-note">连续输错会被临时锁定，锁定时间逐次翻倍。</p>
      </div>
    </div>
  );
}
