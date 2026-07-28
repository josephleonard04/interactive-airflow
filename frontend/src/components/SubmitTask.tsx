import { useState } from "react";
import { useSceneStore, type SessionReport } from "../scene/store";

// "I'm done." — the end of a session.
//
// Submitting seals the log and delivers it. Delivery is two things at once,
// because a study runs in places the network doesn't always reach:
//
//   1. it always downloads the report as JSON, so a participant sitting next to
//      the facilitator can just hand the file over, and
//   2. if the build was given a collection endpoint (VITE_LOG_ENDPOINT), it
//      POSTs the same JSON there, so a participant trying the link from home
//      needs to do nothing at all.
//
// The report is the whole timeline: every manual move, every typed goal, every
// sketch, every suggestion offered and accepted, and the tick-box verdict each
// time it changed — plus a final scoring of the goals against the plan as
// submitted, so "did they actually finish?" is answered by the file rather than
// by asking them.

const ENDPOINT = import.meta.env.VITE_LOG_ENDPOINT as string | undefined;

function download(report: SessionReport) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `airflow-session-${report.scenario ?? "free"}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function SubmitTask() {
  const scenarioId = useSceneStore((s) => s.scenarioId);
  const submitSession = useSceneStore((s) => s.submitSession);
  const submitted = useSceneStore((s) => s.submitted);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<"none" | "ok" | "failed">("none");

  if (!scenarioId) return null;

  const onSubmit = async () => {
    setBusy(true);
    try {
      const report = submitSession();
      if (!report) return;
      download(report);
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
    return (
      <section className="selected-box" style={{ borderLeft: "3px solid #2a9d8f" }}>
        <h2 style={{ marginBottom: 4 }}>Submitted — thank you</h2>
        <p className="muted-line" style={{ margin: 0 }}>
          {submitted.goals.length > 0
            ? `${submitted.goals.filter((g) => g.met).length} of ${submitted.goals.length} goals met · `
            : ""}
          {Math.round(submitted.durationSec / 6) / 10} min
          {ENDPOINT ? (sent === "ok" ? " · sent" : sent === "failed" ? " · not sent (saved to your downloads)" : "") : ""}
        </p>
        <p className="muted-line" style={{ marginTop: 4 }}>
          A copy of your session was saved to your downloads
          {ENDPOINT && sent === "ok" ? " and sent to the researcher." : "."}
        </p>
      </section>
    );
  }

  return (
    <section className="actions">
      <button className="primary" style={{ width: "100%" }} disabled={busy} onClick={onSubmit}>
        {busy ? "Submitting…" : "✅ Submit — I'm done"}
      </button>
      <p className="muted-line" style={{ marginTop: 5 }}>
        Ends the task and sends what you did to the researcher.
      </p>
    </section>
  );
}
