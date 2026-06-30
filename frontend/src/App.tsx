import { Editor } from "./components/Editor";
import { Panel } from "./components/Panel";
import { SetupScreen } from "./components/SetupScreen";
import { SimPanel } from "./components/SimPanel";
import { useSceneStore } from "./scene/store";

export function App() {
  const started = useSceneStore((s) => s.started);

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
