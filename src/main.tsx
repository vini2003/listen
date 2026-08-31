import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "framer-motion";
import "@fontsource-variable/inter";
import App from "./App";
import { AssistantWindow } from "./components/assistant/AssistantWindow";
import "./styles.css";

const query = new URLSearchParams(window.location.search);
const assistantView = query.get("view") === "assistant";
const content = assistantView
  ? <AssistantWindow initialMeetingId={query.get("meetingId")} />
  : <App />;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      {content}
    </MotionConfig>
  </React.StrictMode>,
);
