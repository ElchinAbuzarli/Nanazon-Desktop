import { useEffect, useState } from "react";

interface ToastData {
  title: string;
  message: string;
  id: number;
}

let toastId = 0;
let addToastFn: ((title: string, message: string) => void) | null = null;

export function showToast(title: string, message: string) {
  addToastFn?.(title, message);
}

export default function Toast() {
  const [toasts, setToasts] = useState<ToastData[]>([]);

  useEffect(() => {
    addToastFn = (title: string, message: string) => {
      const id = ++toastId;
      setToasts((prev) => [...prev, { title, message, id }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4000);
    };
    return () => { addToastFn = null; };
  }, []);

  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className="app-toast show">
          <div className="app-toast-title">{t.title}</div>
          <div className="app-toast-message">{t.message}</div>
        </div>
      ))}
    </div>
  );
}
