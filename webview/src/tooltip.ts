import './tooltip.css';

// Native `title` tooltips are not rendered inside webviews in some editors (Cursor),
// so hover text is drawn by the page itself. Any element with a `title` gets it.
const SHOW_DELAY_MS = 450;
const MARGIN = 6;

export function installTooltips(doc: Document = document): void {
  const tip = doc.createElement('div');
  tip.className = 'gl-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  doc.body.appendChild(tip);

  let target: HTMLElement | undefined;
  let timer: number | undefined;

  const textOf = (element: HTMLElement): string => {
    const title = element.getAttribute('title');
    if (title !== null) {
      // Keep the text but drop the native tooltip so the two never show at once.
      element.dataset.tip = title;
      element.removeAttribute('title');
    }
    return element.dataset.tip ?? '';
  };

  const hide = (): void => {
    window.clearTimeout(timer);
    timer = undefined;
    target = undefined;
    tip.hidden = true;
  };

  const show = (element: HTMLElement): void => {
    const text = textOf(element);
    if (!text || !element.isConnected) return;
    tip.textContent = text;
    tip.hidden = false;
    const anchor = element.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const viewportWidth = doc.documentElement.clientWidth;
    const viewportHeight = doc.documentElement.clientHeight;
    let left = anchor.left + anchor.width / 2 - box.width / 2;
    left = Math.max(MARGIN, Math.min(left, viewportWidth - box.width - MARGIN));
    let top = anchor.bottom + MARGIN;
    if (top + box.height > viewportHeight - MARGIN) top = Math.max(MARGIN, anchor.top - box.height - MARGIN);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  doc.addEventListener('mouseover', (event) => {
    const element = (event.target as Element | null)?.closest<HTMLElement>('[title], [data-tip]');
    if (element === target) return;
    hide();
    if (!element) return;
    target = element;
    textOf(element);
    timer = window.setTimeout(() => show(element), SHOW_DELAY_MS);
  });
  doc.addEventListener('mouseleave', hide);
  doc.addEventListener('mousedown', hide, true);
  doc.addEventListener('keydown', hide, true);
  doc.addEventListener('scroll', hide, true);
  doc.addEventListener('contextmenu', hide, true);
}
