import { useState } from "react";
import { Editor } from "./components/Editor";
import { Panel } from "./components/Panel";
import { SetupScreen } from "./components/SetupScreen";
import { SimPanel } from "./components/SimPanel";
import { TitleScreen } from "./components/TitleScreen";
import { useSceneStore } from "./scene/store";

export function App() {
  const started = useSceneStore((s) => s.started);
  // Title and teaser first, then the demo — see TitleScreen. Not remembered
  // across reloads on purpose: a shared link should always open on the paper.
  const [exploring, setExploring] = useState(false);

  if (!started && !exploring) return <TitleScreen onExplore={() => setExploring(true)} />;
  if (!started) return <SetupScreen />;

  return (
    <div className="app">
      <main className="viewport">
        <Editor />
        <SimPanel />
      </main>
      <Panel />
    </div>
  );
}
