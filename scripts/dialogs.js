/**
 * One confirm that works on both core versions.
 *
 * `Dialog` is deprecated in v13 and slated for removal, but the module still
 * declares v12 as its minimum, where `DialogV2` is not dependable. Picking the
 * newer API when it is present and falling back otherwise keeps both working
 * without two call sites everywhere.
 */
export async function confirm({ title, content, defaultYes = true }) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;

  if (DialogV2?.confirm) {
    return DialogV2.confirm({
      window: { title },
      content,
      // V2 rejects rather than resolving false when dismissed, which would turn
      // "closed the window" into an unhandled rejection at every call site.
      rejectClose: false,
      modal: true,
      yes: { default: defaultYes },
      no: { default: !defaultYes }
    });
  }

  return Dialog.confirm({ title, content, defaultYes });
}

/** Template rendering moved namespace in v13; the global is deprecated. */
export async function render(path, data) {
  const renderer = foundry?.applications?.handlebars?.renderTemplate
    ?? globalThis.renderTemplate;
  return renderer(path, data);
}
