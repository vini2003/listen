import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, Info, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import type { AppToast } from "../../store/workspace";

interface ToastViewportProps {
  toasts: AppToast[];
  onDismiss: (id: number) => void;
  children?: ReactNode;
}

export function ToastViewport({ toasts, onDismiss, children }: ToastViewportProps) {
  return (
    <div className="toast-viewport" aria-atomic="false">
      {children}
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: AppToast; onDismiss: (id: number) => void }) {
  const notice = toast.tone === "notice";
  useEffect(() => {
    // Notices carry instructions, so they stay a little longer.
    const timer = window.setTimeout(() => onDismiss(toast.id), notice ? 9_000 : 6_000);
    return () => window.clearTimeout(timer);
  }, [notice, onDismiss, toast.id]);

  return (
    <motion.div
      className={notice ? "error-toast notice-toast" : "error-toast"}
      role={notice ? "status" : "alert"}
      initial={{ opacity: 0, x: 24, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 18, scale: 0.98 }}
      transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
    >
      {notice ? <Info size={17} /> : <AlertCircle size={17} />}
      <span>{toast.message}</span>
      <button onClick={() => onDismiss(toast.id)} aria-label={notice ? "Dismiss" : "Dismiss error"}>
        <X size={15} />
      </button>
    </motion.div>
  );
}
