import type { GeneratedAdapterFile } from "./types.ts";

export function verifiedInteractionRuntimeFile(): GeneratedAdapterFile {
  return {
    path: "interactions/installVerifiedInteractions.ts",
    role: "interaction",
    contents: `export function installVerifiedInteractions(root: Document = document): () => void {
  const disposers: Array<() => void> = [];
  for (const trigger of root.querySelectorAll<HTMLButtonElement>("[data-g2p-dialog-trigger]")) {
    const targetId = trigger.dataset.g2pDialogTrigger;
    const target = targetId ? root.getElementById(targetId) : null;
    if (!(target instanceof HTMLDialogElement)) continue;
    const open = () => {
      target.showModal();
      trigger.setAttribute("aria-expanded", "true");
    };
    const close = () => trigger.setAttribute("aria-expanded", "false");
    trigger.addEventListener("click", open);
    target.addEventListener("close", close);
    disposers.push(() => {
      trigger.removeEventListener("click", open);
      target.removeEventListener("close", close);
    });
  }
  return () => disposers.forEach((dispose) => dispose());
}
`,
  };
}
