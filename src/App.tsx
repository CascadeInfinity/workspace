import { useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

type DocumentKind = "markdown" | "latex" | "code";

type WorkspaceDocument = {
  id: string;
  name: string;
  kind: DocumentKind;
  content: string;
  updated_at: string;
};

type Task = {
  id: string;
  title: string;
  due_date: string | null;
  done: boolean;
};

type P2PStatus = {
  local_peer_id: string;
  peer_count: number;
  mode: string;
};

const getSeedDocuments = (): WorkspaceDocument[] => [
  {
    id: "doc-markdown",
    name: "Daily Notes.md",
    kind: "markdown",
    content: "# Daily plan\n\n- Review goals\n- Ship the feature\n- Capture follow-ups",
    updated_at: new Date().toISOString(),
  },
  {
    id: "doc-latex",
    name: "Research.tex",
    kind: "latex",
    content: "\\section{Summary}\n\\begin{equation}\nE = mc^2\n\\end{equation}",
    updated_at: new Date().toISOString(),
  },
  {
    id: "doc-code",
    name: "sync.rs",
    kind: "code",
    content: "fn main() {\n    println!(\"Northstar workspace ready\");\n}\n",
    updated_at: new Date().toISOString(),
  },
];

const getLanguageExtension = (kind: DocumentKind) => {
  switch (kind) {
    case "markdown":
      return markdown();
    case "latex":
      return StreamLanguage.define(stex);
    case "code":
      return javascript({ jsx: true });
    default:
      return json();
  }
};

const describeKind = (kind: DocumentKind) => {
  switch (kind) {
    case "markdown":
      return "Markdown";
    case "latex":
      return "LaTeX";
    case "code":
      return "Code";
    default:
      return "Text";
  }
};

const dateToIso = (date: Date) => date.toISOString().slice(0, 10);

const buildCalendar = (tasks: Task[]) => {
  const days: Array<{ key: string; date: Date; tasks: Task[] }> = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + offset);
    const iso = dateToIso(date);
    days.push({
      key: iso,
      date,
      tasks: tasks.filter((task) => task.due_date === iso),
    });
  }

  return days;
};

export default function App() {
  const [documents, setDocuments] = useState<WorkspaceDocument[]>([]);
  const [selectedId, setSelectedId] = useState<string>("doc-markdown");
  const [taskDraft, setTaskDraft] = useState("");
  const [taskDate, setTaskDate] = useState(dateToIso(new Date()));
  const [tasks, setTasks] = useState<Task[]>([]);
  const [p2pStatus, setP2PStatus] = useState<P2PStatus>({
    local_peer_id: "initializing",
    peer_count: 0,
    mode: "mdns + gossipsub",
  });

  const editorRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  const selectedDocument = useMemo(
    () => documents.find((document) => document.id === selectedId) ?? documents[0],
    [documents, selectedId],
  );

  const calendarDays = useMemo(() => buildCalendar(tasks), [tasks]);

  useEffect(() => {
    const loadData = async () => {
      try {
        const storedDocuments = (await invoke<WorkspaceDocument[]>("list_documents")) ?? [];
        const storedTasks = (await invoke<Task[]>("list_tasks")) ?? [];
        const nextDocuments = storedDocuments.length > 0 ? storedDocuments : getSeedDocuments();
        setDocuments(nextDocuments);
        setSelectedId((current) => current || nextDocuments[0]?.id || "doc-markdown");
        setTasks(storedTasks);
      } catch (error) {
        const nextDocuments = getSeedDocuments();
        setDocuments(nextDocuments);
        setSelectedId((current) => current || nextDocuments[0].id);
      }

      try {
        const status = await invoke<P2PStatus>("get_collaboration_status");
        setP2PStatus(status);
      } catch {
        setP2PStatus({
          local_peer_id: "offline",
          peer_count: 0,
          mode: "mdns + gossipsub",
        });
      }
    };

    void loadData();
  }, []);

  useEffect(() => {
    if (!selectedDocument || !editorRef.current) {
      return;
    }

    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }

    const state = EditorState.create({
      doc: selectedDocument.content,
      extensions: [
        EditorView.lineWrapping,
        EditorView.theme({
          "&": {
            height: "100%",
            background: "#f6f7fb",
            color: "#17212c",
            fontSize: "14px",
            borderRadius: "12px",
          },
          ".cm-scroller": {
            fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
            lineHeight: "1.7",
          },
          ".cm-content": {
            padding: "16px",
            minHeight: "480px",
          },
          ".cm-focused": { outline: "none" },
        }),
        getLanguageExtension(selectedDocument.kind),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const nextContent = update.state.doc.toString();
            void updateSelectedDocument(nextContent);
          }
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [selectedDocument]);

  const updateSelectedDocument = async (nextContent: string) => {
    if (!selectedDocument) {
      return;
    }

    const updatedDocument: WorkspaceDocument = {
      ...selectedDocument,
      content: nextContent,
      updated_at: new Date().toISOString(),
    };

    try {
      await invoke("save_document", { document: updatedDocument });
      setDocuments((currentDocuments) =>
        currentDocuments.map((document) =>
          document.id === updatedDocument.id ? updatedDocument : document,
        ),
      );
    } catch (error) {
      console.error("Failed to save document", error);
    }
  };

  const handleAddTask = async () => {
    if (!taskDraft.trim()) {
      return;
    }

    const nextTask: Task = {
      id: `${Date.now()}`,
      title: taskDraft.trim(),
      due_date: taskDate,
      done: false,
    };

    try {
      await invoke("save_task", { task: nextTask });
      setTasks((currentTasks) => [...currentTasks, nextTask]);
      setTaskDraft("");
    } catch (error) {
      console.error("Unable to save task", error);
    }
  };

  const handleToggleTask = async (task: Task) => {
    const updatedTask = { ...task, done: !task.done };

    try {
      await invoke("save_task", { task: updatedTask });
      setTasks((currentTasks) =>
        currentTasks.map((entry) => (entry.id === task.id ? updatedTask : entry)),
      );
    } catch (error) {
      console.error("Unable to toggle task", error);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Desktop workspace</p>
          <h1>Northstar Workspace</h1>
        </div>
        <div className="sync-pill">
          <span className="status-dot" />
          {p2pStatus.peer_count} peers synced
        </div>
      </header>

      <main className="workspace-grid">
        <aside className="sidebar panel">
          <div className="panel-header">
            <h2>Documents</h2>
            <button className="ghost-button">New</button>
          </div>

          <div className="doc-list">
            {documents.map((document) => (
              <button
                key={document.id}
                className={`doc-item ${document.id === selectedDocument?.id ? "selected" : ""}`}
                onClick={() => setSelectedId(document.id)}
                type="button"
              >
                <span className="doc-badge">{describeKind(document.kind).slice(0, 2).toUpperCase()}</span>
                <span className="doc-meta">
                  <strong>{document.name}</strong>
                  <small>{describeKind(document.kind)}</small>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="editor-panel panel">
          <div className="panel-header editor-header">
            <div>
              <p className="eyebrow">Open document</p>
              <h2>{selectedDocument?.name ?? "Untitled"}</h2>
            </div>
            <button
              className="primary-button"
              type="button"
              onClick={() => void updateSelectedDocument(viewRef.current?.state.doc.toString() ?? "")}
            >
              Save
            </button>
          </div>

          <div className="editor-surface">
            <div ref={editorRef} className="editor-root" />
          </div>
        </section>

        <aside className="rightbar panel">
          <div className="panel-header">
            <h2>Tasks</h2>
          </div>

          <div className="task-form">
            <input
              type="text"
              value={taskDraft}
              onChange={(event) => setTaskDraft(event.target.value)}
              placeholder="Add task"
            />
            <input
              type="date"
              value={taskDate}
              onChange={(event) => setTaskDate(event.target.value)}
            />
            <button type="button" onClick={() => void handleAddTask()}>
              Add
            </button>
          </div>

          <div className="task-list">
            {tasks.map((task) => (
              <label key={task.id} className={`task-item ${task.done ? "done" : ""}`}>
                <input
                  type="checkbox"
                  checked={task.done}
                  onChange={() => void handleToggleTask(task)}
                />
                <span>{task.title}</span>
                <small>{task.due_date ?? "No due date"}</small>
              </label>
            ))}
          </div>

          <div className="calendar-panel">
            <h3>Calendar</h3>
            <div className="calendar-grid">
              {calendarDays.map((day) => (
                <div key={day.key} className="day-card">
                  <strong>{day.date.toLocaleDateString(undefined, { weekday: "short" })}</strong>
                  <span>{day.date.getDate()}</span>
                  <ul>
                    {day.tasks.length > 0 ? (
                      day.tasks.map((task) => (
                        <li key={task.id}>{task.title}</li>
                      ))
                    ) : (
                      <li className="empty-day">Free</li>
                    )}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          <div className="peer-panel">
            <h3>Peer sync</h3>
            <p>{p2pStatus.local_peer_id}</p>
            <p>{p2pStatus.mode}</p>
          </div>
        </aside>
      </main>
    </div>
  );
}
