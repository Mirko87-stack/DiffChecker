// The file rail can be widened, narrowed or hidden; the choice is remembered per browser.
// Below 900 px the rail is the collapsible list above the content, so none of this applies there.
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 180;
const MAX_SHARE = 0.45; // of the viewport width
const STEP = 16;
const WIDTH_KEY = "diffchecker.railWidth";
const HIDDEN_KEY = "diffchecker.railHidden";

export function initSidebar() {
  const layout = document.querySelector(".layout");
  const handle = document.getElementById("rail-handle");
  const hideButton = document.getElementById("rail-hide");
  const showButton = document.getElementById("rail-show");
  let width = clamp(storedWidth());

  // Applied before the session loads, so the first paint already has the reader's layout.
  applyWidth(width);
  layout.classList.toggle("rail-hidden", readStored(HIDDEN_KEY) === "true");

  function applyWidth(next) {
    layout.style.setProperty("--rail-width", `${next}px`);
    handle.setAttribute("aria-valuemin", String(MIN_WIDTH));
    handle.setAttribute("aria-valuemax", String(maxWidth()));
    handle.setAttribute("aria-valuenow", String(next));
  }

  function resizeTo(next) {
    width = clamp(next);
    applyWidth(width);
  }

  function setHidden(hidden) {
    layout.classList.toggle("rail-hidden", hidden);
    writeStored(HIDDEN_KEY, String(hidden));
    (hidden ? showButton : hideButton).focus();
  }

  hideButton.addEventListener("click", () => setHidden(true));
  showButton.addEventListener("click", () => setHidden(false));

  // Pointer capture keeps the drag going when the pointer leaves the thin handle.
  let drag = null;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, width };
    document.documentElement.classList.add("rail-resizing");
  });
  handle.addEventListener("pointermove", (event) => {
    if (drag) resizeTo(drag.width + event.clientX - drag.x);
  });
  for (const type of ["pointerup", "pointercancel"]) {
    handle.addEventListener(type, () => {
      if (!drag) return;
      drag = null;
      document.documentElement.classList.remove("rail-resizing");
      writeStored(WIDTH_KEY, String(width));
    });
  }
  handle.addEventListener("dblclick", () => {
    resizeTo(DEFAULT_WIDTH);
    writeStored(WIDTH_KEY, String(width));
  });
  handle.addEventListener("keydown", (event) => {
    const next = {
      ArrowLeft: width - STEP,
      ArrowRight: width + STEP,
      Home: MIN_WIDTH,
      End: maxWidth(),
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    resizeTo(next);
    writeStored(WIDTH_KEY, String(width));
  });

  // A smaller window lowers the ceiling; the stored preference is kept for a larger one.
  addEventListener("resize", () => resizeTo(storedWidth()));
}

function storedWidth() {
  return Number(readStored(WIDTH_KEY)) || DEFAULT_WIDTH;
}

function maxWidth() {
  return Math.max(MIN_WIDTH, Math.floor(innerWidth * MAX_SHARE));
}

function clamp(value) {
  return Math.round(Math.min(maxWidth(), Math.max(MIN_WIDTH, value)));
}

// Storage can be disabled (private windows, strict settings); the rail then just forgets.
function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered; the current layout still applies.
  }
}
