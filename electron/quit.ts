/** The bridge runs in Electron's process. Its save acknowledgement starts the cleanup budget. */
export function closeForQuit(close: (saved: () => void) => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer = setTimeout(() => reject(new Error('Timed out saving the conversations.')), 10_000);
    let acknowledged = false;
    const saved = () => {
      if (acknowledged) return;
      acknowledged = true;
      clearTimeout(timer);
      timer = setTimeout(resolve, 3000);
    };
    Promise.resolve().then(() => close(saved)).then(() => {
      if (acknowledged) resolve();
      else reject(new Error('The bridge closed without confirming that the conversations were saved.'));
    }, reject).finally(() => clearTimeout(timer));
  });
}
