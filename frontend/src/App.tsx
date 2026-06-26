import { Editor } from "./components/Editor";
import { FlowView } from "./components/FlowView";
import { Panel } from "./components/Panel";
import { SetupScreen } from "./components/SetupScreen";
import { useSceneStore } from "./scene/store";

export function App() {
  const started = useSceneStore((s) => s.started);

  if (!started) return <SetupScreen />;

  return (
    <div className="app">
      <Panel />
      <main className="viewport">
        <Editor />
        <FlowView />
      </main>
    </div>
  );
}
