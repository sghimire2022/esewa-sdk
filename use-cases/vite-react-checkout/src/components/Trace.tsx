import type { ReactNode } from "react";
import type { OrderEvent } from "../../shared/types";

/**
 * The developer-facing side panel: it shows what the SDK sent to and got back
 * from eSewa, so you can see the integration working rather than take it on trust.
 */
export function TracePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside className="trace" aria-label="What the SDK did">
      <h2 className="trace-title">{title}</h2>
      {children}
    </aside>
  );
}

export function FieldTable({ fields }: { fields: Record<string, string> }) {
  const signed = new Set((fields.signed_field_names ?? "").split(","));
  return (
    <table className="fields">
      <caption>
        Form fields posted to eSewa. Highlighted rows are covered by the HMAC-SHA256 signature.
      </caption>
      <tbody>
        {Object.entries(fields).map(([name, value]) => (
          <tr key={name} className={signed.has(name) ? "is-signed" : undefined}>
            <th scope="row">{name}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const KIND_LABEL: Record<OrderEvent["kind"], string> = {
  info: "Info",
  ok: "Done",
  warn: "Note",
  error: "Problem",
};

export function EventLog({ events }: { events: OrderEvent[] }) {
  if (!events.length) return <p className="trace-empty">Nothing has happened to this order yet.</p>;
  return (
    <ol className="events">
      {events.map((e, i) => (
        <li key={i} className={`event event-${e.kind}`}>
          <div className="event-head">
            <span className="event-kind">{KIND_LABEL[e.kind]}</span>
            <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString()}</time>
          </div>
          <p className="event-text">{e.text}</p>
          {e.data !== undefined && (
            <dl className="event-data">
              {Object.entries(e.data as Record<string, unknown>)
                .filter(([, v]) => v !== undefined && v !== null)
                .map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{String(v)}</dd>
                  </div>
                ))}
            </dl>
          )}
        </li>
      ))}
    </ol>
  );
}

export function TestCredentials() {
  return (
    <div className="creds">
      <p>Log in on eSewa's test page with:</p>
      <dl>
        <div>
          <dt>eSewa ID</dt>
          <dd>9806800001</dd>
        </div>
        <div>
          <dt>Password</dt>
          <dd>Nepal@123</dd>
        </div>
        <div>
          <dt>OTP</dt>
          <dd>123456</dd>
        </div>
      </dl>
    </div>
  );
}
