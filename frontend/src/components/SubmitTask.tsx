import { useState } from "react";
import { useSceneStore, type SessionReport } from "../scene/store";

// "I'm done." — the end of a session.
//
// Submit downloads the session as one JSON file and says so, plainly, naming the
// file. That is the whole delivery mechanism: these sessions are run with a
// facilitator on a call or in the room, who asks for the file at the end. The
// participant is told what to do by a person, so the screen's only job is to
// make sure the file exists and is easy to name.
//
// NOTHING OPENS BY ITSELF. An earlier version launched the mail client the
// moment Submit was pressed. That is a surprise — a strange window over the top
// of the study, in an app they may not use, at the exact moment they think they
// have finished — and it replaced a person's clear instruction with a guess at
// one. Emailing is still one click if they want it, but it is offered, not
// sprung.
//
// Two backstops behind the download, because a file that never arrives is a
// session that never happened: the report is also kept in localStorage under
// `airflow-last-session`, and if the build was given VITE_LOG_ENDPOINT it is
// POSTed there as well.
//
// The report is the whole timeline: every manual move, every typed goal, every
// sketch, every suggestion offered and accepted, and the tick-box verdict each
// time it changed — plus a final scoring of the goals against the plan as
// submitted, so "did they actually finish?" is answered by the file rather than
// by asking them.

const ENDPOINT = import.meta.env.VITE_LOG_ENDPOINT as string | undefined;
// Base64 first: that is the form the deploy workflow sets, so the published
// bundle never carries the address in plain text. The plain variable stays
// supported for a local .env.local, where nothing is published.
const EMAIL = (() => {
  const b64 = import.meta.env.VITE_RESEARCHER_EMAIL_B64;
  if (b64) {
    try {
      return atob(b64);
    } catch {
      /* malformed — fall through to the plain variable */
    }
  }
  return import.meta.env.VITE_RESEARCHER_EMAIL;
})();

/** Where the last submitted report is kept, so a session is not lost if the
 *  participant closes the tab without sending the mail. The facilitator can
 *  recover it from the browser console with
 *  `localStorage.getItem("airflow-last-session")`. */
const LAST_SESSION_KEY = "airflow-last-session";

function fileNameFor(report: SessionReport) {
  return `airflow-session-${report.scenario ?? "free"}-${new Date(report.submittedAt)
    .toISOString()
    .slice(0, 19)
    .replace(/[:T]/g, "-")}.json`;
}

function download(report: SessionReport, name: string) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** A mail draft the participant only has to attach the file to and send. The
 *  report itself is far too big for a mailto body (mail clients truncate around
 *  a couple of thousand characters), so the body carries the summary and names
 *  the file sitting in their downloads folder. */
function mailtoFor(report: SessionReport, name: string) {
  const met = report.goals.filter((g) => g.met).length;
  const body = [
    "Here is my session from the airflow study.",
    "",
    `Task: ${report.title ?? report.scenario ?? "free play"}`,
    `Goals met: ${met} of ${report.goals.length}`,
    `Time taken: ${Math.round(report.durationSec / 6) / 10} minutes`,
    "",
    `Please attach the file that was just downloaded: ${name}`,
    "",
    "Anything you found confusing:",
    "",
  ].join("\n");
  return `mailto:${EMAIL}?subject=${encodeURIComponent(
    `Airflow study session — ${report.title ?? report.scenario ?? "free play"}`,
  )}&body=${encodeURIComponent(body)}`;
}

export function SubmitTask() {
  const scenarioId = useSceneStore((s) => s.scenarioId);
  const submitSession = useSceneStore((s) => s.submitSession);
  const submitted = useSceneStore((s) => s.submitted);
  const exitScenario = useSceneStore((s) => s.exitScenario);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<"none" | "ok" | "failed">("none");
  const [file, setFile] = useState("");
  const [copied, setCopied] = useState(false);

  if (!scenarioId) return null;

  const onSubmit = async () => {
    setBusy(true);
    try {
      const report = submitSession();
      if (!report) return;
      const name = fileNameFor(report);
      setFile(name);
      download(report, name);
      // Belt and braces: a participant who closes the tab without handing the
      // file over has still left the session somewhere recoverable.
      try {
        localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(report));
      } catch {
        /* private mode / quota — the download still happened */
      }
      if (ENDPOINT) {
        try {
          const res = await fetch(ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(report),
          });
          setSent(res.ok ? "ok" : "failed");
        } catch {
          setSent("failed");
        }
      }
    } finally {
      setBusy(false);
    }
  };

  if (submitted) {
    const name = file || fileNameFor(submitted);
    return (
      <section className="selected-box" style={{ borderLeft: "3px solid #2a9d8f" }}>
        <h2 style={{ marginBottom: 4 }}>Submitted — thank you</h2>
        <p className="muted-line" style={{ margin: 0 }}>
          {submitted.goals.length > 0
            ? `${submitted.goals.filter((g) => g.met).length} of ${submitted.goals.length} goals met · `
            : ""}
          {Math.round(submitted.durationSec / 6) / 10} min
          {ENDPOINT ? (sent === "ok" ? " · sent" : sent === "failed" ? " · not sent" : "") : ""}
        </p>
        {/* The one instruction that matters, in plain words and not muted: the
            file exists, here is what it is called, please pass it on. The
            facilitator says the rest. */}
        <p style={{ fontSize: 12.5, lineHeight: 1.5, margin: "8px 0 0" }}>
          Your session was saved to your <b>Downloads</b> folder as:
        </p>
        <code
          style={{
            display: "block",
            margin: "5px 0 8px",
            padding: "6px 8px",
            borderRadius: 8,
            background: "#fff",
            border: "1px solid var(--line)",
            fontSize: 11,
            wordBreak: "break-all",
          }}
        >
          {name}
        </code>
        <p className="muted-line" style={{ margin: 0 }}>
          {ENDPOINT && sent === "ok"
            ? "It has also been sent to the researcher automatically — nothing else to do."
            : "Please send that file to the researcher."}
        </p>
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <button
            className="tool"
            style={{ flex: 1, fontSize: 11.5 }}
            title="If the download did not appear, or you deleted it"
            onClick={() => download(submitted, name)}
          >
            ⬇ Download again
          </button>
          {EMAIL && (
            <a
              className="tool"
              style={{ flex: 1, textAlign: "center", fontSize: 11.5, padding: "5px 8px" }}
              href={mailtoFor(submitted, name)}
              title="Opens your email with the message written — attach the file above"
            >
              📧 Email it
            </a>
          )}
          <button
            className="tool"
            style={{ flex: 1, fontSize: 11.5 }}
            title="Copy the report itself, if sending the file is awkward"
            onClick={() => {
              void navigator.clipboard?.writeText(JSON.stringify(submitted, null, 2));
              setCopied(true);
            }}
          >
            {copied ? "✓ Copied" : "Copy"}
          </button>
        </div>
        {/* The way on. A session ends on this panel, and without a door out of
            it the only way to try the next task is to reload the page. */}
        <button
          className="primary"
          style={{ width: "100%", marginTop: 10 }}
          onClick={exitScenario}
          title="Back to the start screen, where you can pick another task"
        >
          ← Back to the start
        </button>
      </section>
    );
  }

  return (
    <section className="actions">
      <button className="primary" style={{ width: "100%" }} disabled={busy} onClick={onSubmit}>
        {busy ? "Submitting…" : "✅ Submit — I'm done"}
      </button>
      <p className="muted-line" style={{ marginTop: 5 }}>
        Ends the task and saves what you did as a file to give to the researcher.
      </p>
    </section>
  );
}
