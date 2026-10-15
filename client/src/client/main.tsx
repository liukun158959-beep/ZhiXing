import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import "reend-components/styles.css";
import "./index.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("缺少 #root。恢复：检查 client.html");
}
const ChatPreview = lazy(() => import("./chat-prototype").then(module => ({ default: module.ChatPrototype })));
const LiveCollaboration = lazy(() => import("./live-collaboration").then(module => ({ default: module.LiveCollaboration })));
const App = lazy(() => import("./App").then(module => ({ default: module.App })));
const preview = new URLSearchParams(window.location.search).get("preview") === "chat";
// The standalone preview never mounts App: no backend startup, credentials, or real chat requests.
const live = preview && new URLSearchParams(window.location.search).get("live") === "1";
createRoot(root).render(<Suspense fallback={<p>正在载入界面…</p>}>{live ? <LiveCollaboration standalone /> : preview ? <ChatPreview standalone /> : <App />}</Suspense>);
