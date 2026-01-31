import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { useStore, type DialogResult } from "../lib/store";

export function Modal({
  title,
  children,
  footer,
  onClose,
  size,
  icon,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  size?: "wide" | "full";
  icon?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size ?? ""}`}>
        <div className="modal-head">
          {icon}
          {title}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Bar({ value, tone }: { value: number; tone?: "auto" | "ok" }) {
  const v = Math.max(0, Math.min(100, value || 0));
  const cls = tone === "ok" ? "ok" : v > 90 ? "err" : v > 75 ? "warn" : "";
  return (
    <div className={`bar ${cls}`}>
      <i style={{ width: `${v}%` }} />
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <div style={{ fontWeight: 500, color: "var(--text)" }}>{title}</div>
      {children}
    </div>
  );
}

/** Globaler Dialog für ask()/confirm() aus dem Store. */
export function DialogHost() {
  const dialog = useStore((s) => s.dialog);
  const [values, setValues] = useState<DialogResult>({});
  const firstInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!dialog) return;
    const init: DialogResult = {};
    for (const f of dialog.fields ?? []) {
      init[f.name] = f.value ?? (f.type === "checkbox" ? false : f.type === "select" ? (f.options?.[0]?.value ?? "") : "");
    }
    setValues(init);
    setTimeout(() => firstInput.current?.focus(), 30);
  }, [dialog]);

  if (!dialog) return null;
  const submit = () => dialog.resolve(values);
  const cancel = () => dialog.resolve(null);
  let focused = false;

  return (
    <Modal
      title={dialog.title}
      onClose={cancel}
      icon={dialog.danger ? <AlertTriangle size={16} className="err" /> : undefined}
      footer={
        <>
          {dialog.cancel !== null && (
            <button className="btn" onClick={cancel}>
              {dialog.cancel ?? "Abbrechen"}
            </button>
          )}
          <button className={`btn ${dialog.danger ? "danger solid" : "primary"}`} onClick={submit}>
            {dialog.confirm ?? "OK"}
          </button>
        </>
      }
    >
      {dialog.message && <div className="muted">{dialog.message}</div>}
      {dialog.detail && <div className="detail mono selectable">{dialog.detail}</div>}
      <form
        className="col"
        style={{ gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {(dialog.fields ?? []).map((f) => {
          const set = (v: string | boolean) => setValues((s) => ({ ...s, [f.name]: v }));
          if (f.type === "checkbox") {
            return (
              <label key={f.name} className="check">
                <input type="checkbox" checked={!!values[f.name]} onChange={(e) => set(e.target.checked)} />
                {f.label}
              </label>
            );
          }
          if (f.type === "select") {
            return (
              <Field key={f.name} label={f.label}>
                <select className="select" value={String(values[f.name] ?? "")} onChange={(e) => set(e.target.value)}>
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
            );
          }
          if (f.type === "textarea") {
            return (
              <Field key={f.name} label={f.label}>
                <textarea
                  className="textarea"
                  rows={4}
                  placeholder={f.placeholder}
                  value={String(values[f.name] ?? "")}
                  onChange={(e) => set(e.target.value)}
                />
              </Field>
            );
          }
          const ref = !focused ? ((focused = true), firstInput) : undefined;
          return (
            <Field key={f.name} label={f.label}>
              <input
                ref={ref}
                className="input"
                type={f.type === "password" ? "password" : "text"}
                placeholder={f.placeholder}
                value={String(values[f.name] ?? "")}
                onChange={(e) => set(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          );
        })}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === "error" ? (
            <AlertTriangle size={15} className="err" />
          ) : t.kind === "ok" ? (
            <CheckCircle2 size={15} className="ok" />
          ) : (
            <Info size={15} style={{ color: "var(--info)" }} />
          )}
          <div>{t.text}</div>
        </div>
      ))}
    </div>
  );
}

/** Kleines SVG-Liniendiagramm für Verlaufswerte. */
export function Sparkline({ data, max, color = "var(--accent)" }: { data: number[]; max?: number; color?: string }) {
  const W = 200;
  const H = 42;
  const n = 60;
  const pts = data.slice(-n);
  const top = max ?? Math.max(1, ...pts);
  const step = W / (n - 1);
  const offset = n - pts.length;
  const coords = pts.map((v, i) => `${((i + offset) * step).toFixed(1)},${(H - (v / top) * (H - 3) - 1.5).toFixed(1)}`);
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {coords.length > 1 && (
        <>
          <polygon
            points={`${((offset) * step).toFixed(1)},${H} ${coords.join(" ")} ${W},${H}`}
            fill={color}
            opacity="0.1"
          />
          <polyline points={coords.join(" ")} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  );
}
