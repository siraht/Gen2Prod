import type { GeneratedAdapterFile } from "./types.ts";

const RUNTIME_BODY = `  const disposers = [];
  for (const trigger of root.querySelectorAll("[data-g2p-dialog-trigger]")) {
    if (!(trigger instanceof HTMLButtonElement)) continue;
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
  return () => disposers.forEach((dispose) => dispose());`;

export function verifiedInteractionRuntimeFile(): GeneratedAdapterFile {
  return {
    path: "interactions/installVerifiedInteractions.ts",
    role: "interaction",
    contents: `export function installVerifiedInteractions(root: Document = document): () => void {
${RUNTIME_BODY.replace("const disposers = [];", "const disposers: Array<() => void> = [];")}
}
`,
  };
}

export function verifiedInteractionRuntimeJavascriptFile(path = "interactions.js"): GeneratedAdapterFile {
  return {
    path,
    role: "interaction",
    contents: `export function installVerifiedInteractions(root = document) {
${RUNTIME_BODY}
}

installVerifiedInteractions();
`,
  };
}
