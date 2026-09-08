const MODULE_ID = "echo-codex-notes";

Hooks.once("init", () => {
  console.info(`${MODULE_ID} | Echo Codex Notes initialized`);
});

Hooks.once("ready", () => {
  game.settings.register(MODULE_ID, "importNote", {
    name: "Import Echo Codex note",
    hint: "Import a JSON export from Echo Codex as a Journal Entry.",
    scope: "world",
    config: true,
    type: String,
    default: "",
    onChange: (value) => {
      if (value) importEchoCodexNote(value);
    }
  });

  ui.notifications.info("Echo Codex Notes is ready. Use the module setting to import a JSON note.");
});

async function importEchoCodexNote(raw) {
  try {
    const document = typeof raw === "string" ? JSON.parse(raw) : raw;
    const title = document.meta?.title ?? "Echo Codex session";
    const pages = [];

    pages.push({
      name: "Summary",
      type: "text",
      text: { format: 1, content: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(document.meta?.summary ?? "")}</p>` }
    });

    if (document.sections?.length) {
      pages.push({
        name: "Notes",
        type: "text",
        text: { format: 1, content: document.sections.map(section =>
          `<h2>${escapeHtml(section.heading)}</h2><ul>${(section.bullets ?? []).map(b => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`
        ).join("") }
      });
    }

    if (document.decisions?.length || document.tasks?.length || document.openQuestions?.length) {
      pages.push({
        name: "Campaign actions",
        type: "text",
        text: { format: 1, content: [
          document.decisions?.length ? `<h2>Decisions</h2><ul>${document.decisions.map(d => `<li>${escapeHtml(d.statement)}</li>`).join("")}</ul>` : "",
          document.tasks?.length ? `<h2>Action items</h2><ul>${document.tasks.map(t => `<li>${escapeHtml(t.title)}${t.dueDate ? ` — due ${escapeHtml(t.dueDate)}` : ""}</li>`).join("")}</ul>` : "",
          document.openQuestions?.length ? `<h2>Open questions</h2><ul>${document.openQuestions.map(q => `<li>${escapeHtml(q.question)}</li>`).join("")}</ul>` : ""
        ].join("") }
      });
    }

    if (document.transcript) {
      pages.push({
        name: "Transcript",
        type: "text",
        text: { format: 1, content: `<pre>${escapeHtml(document.transcript)}</pre>` }
      });
    }

    await JournalEntry.create({ name: title, pages, flags: { [MODULE_ID]: { source: "Echo Codex" } } });
    ui.notifications.info(`Imported ${title} into a Journal Entry.`);
  } catch (error) {
    console.error(`${MODULE_ID} | Import failed`, error);
    ui.notifications.error("Echo Codex import failed. Check the JSON export format.");
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
