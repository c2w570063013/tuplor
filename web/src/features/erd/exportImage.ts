import { toPng, toSvg } from 'html-to-image';
import { getNodesBounds, getViewportForBounds, type Node } from '@xyflow/react';

const MAX_SIDE = 12000;

/**
 * Render the whole diagram (not just the visible part) to PNG or SVG and download it.
 * The caller must make sure every node is rendered (onlyRenderVisibleElements off).
 */
export async function exportDiagram(container: HTMLElement, nodes: Node[], format: 'png' | 'svg', fileName: string) {
  const viewport = container.querySelector<HTMLElement>('.react-flow__viewport');
  if (!viewport || !nodes.length) throw new Error('Nothing to export');
  const bounds = getNodesBounds(nodes);
  const pad = 48;
  let width = Math.ceil(bounds.width + pad * 2);
  let height = Math.ceil(bounds.height + pad * 2);
  // keep huge diagrams within canvas limits
  const scaleDown = Math.min(1, MAX_SIDE / Math.max(width, height));
  width = Math.ceil(width * scaleDown);
  height = Math.ceil(height * scaleDown);
  const vp = getViewportForBounds(bounds, width, height, scaleDown * 0.5, scaleDown, `${pad * scaleDown}px`);
  const bg = getComputedStyle(container).getPropertyValue('--bg').trim() || getComputedStyle(document.body).backgroundColor;

  const opts = {
    backgroundColor: bg,
    width,
    height,
    pixelRatio: format === 'png' ? (Math.max(width, height) > 6000 ? 1 : 2) : 1,
    style: {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`,
    },
    // skip the invisible handles / edge label portals' pointer layers
    filter: (el: HTMLElement) => !(el.classList?.contains('react-flow__handle')),
  };
  const dataUrl = format === 'png' ? await toPng(viewport, opts) : await toSvg(viewport, opts);
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `${fileName}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
