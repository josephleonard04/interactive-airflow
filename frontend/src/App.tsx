import { Editor } from "./components/Editor";
import { Panel } from "./components/Panel";

export function App() {
  return (
    <div className="app">
      <Panel />
      <main className="viewport">
        <Editor />
      </main>
    </div>
  );
}
