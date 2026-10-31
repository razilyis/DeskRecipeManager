(() => {
  'use strict';

  const FONT_FAMILY = '"Helvetica Neue", Arial, "Hiragino Sans", "Noto Sans JP", sans-serif';
  const HIT_TOLERANCE_CSS = { mouse: 10, pen: 14, touch: 22 }; // ドット判定の余裕（画面上のpx）
  const DOUBLE_TAP_MS = 350;
  const TAP_SLOP_CSS = 6;     // これ以上動いたらタップではなくパン
  const MAX_ZOOM = 8;
  const MOBILE_QUERY = window.matchMedia('(max-width: 800px)');

  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const els = {
    app: $('app'),
    undoBtn: $('undoBtn'),
    panelToggleBtn: $('panelToggleBtn'),
    fullscreenBtn: $('fullscreenBtn'),
    zoomInBtn: $('zoomInBtn'),
    zoomOutBtn: $('zoomOutBtn'),
    zoomFitBtn: $('zoomFitBtn'),
    zoomLevel: $('zoomLevel'),
    rotateLeftBtn: $('rotateLeftBtn'),
    rotateRightBtn: $('rotateRightBtn'),
    fileInput: $('fileInput'),
    projectInput: $('projectInput'),
    saveProjectBtn: $('saveProjectBtn'),
    exportBtn: $('exportBtn'),
    dropzone: $('dropzone'),
    stage: $('stage'),
    canvasWrap: $('canvasWrap'),
    hint: $('hint'),
    popup: $('textPopup'),
    popupInput: $('popupInput'),
    popupOk: $('popupOk'),
    popupCancel: $('popupCancel'),
    editor: $('editor'),
    editorEmpty: $('editorEmpty'),
    labelText: $('labelText'),
    addAnchorBtn: $('addAnchorBtn'),
    removeAnchorBtn: $('removeAnchorBtn'),
    deleteLabelBtn: $('deleteLabelBtn'),
    labelList: $('labelList'),
    fontSize: $('fontSize'),
    fontSizeOut: $('fontSizeOut'),
    labelColor: $('labelColor'),
    labelOpacity: $('labelOpacity'),
    textColor: $('textColor'),
    lineColor: $('lineColor'),
    lineWidth: $('lineWidth'),
    lineShape: $('lineShape'),
    dotSize: $('dotSize'),
  };

  // ---- 状態 ----
  let sourceImage = null;    // 読み込んだ元画像（HTMLImageElement）
  let image = null;          // 回転を反映した表示用画像（canvas）
  let rotation = 0;          // 0 / 90 / 180 / 270（時計回り）
  let imageSrc = null;       // dataURL（プロジェクト保存用）
  let imageName = 'desk';
  let labels = [];           // { id, text, x, y, anchors: [{x, y}] }  x,y はラベル中心（画像座標）
  let style = defaultStyle(1600);
  let selectedId = null;
  let addingAnchorTo = null; // 「線を追加」中のラベルID
  let pendingPoint = null;   // テキスト入力待ちのポイント
  let editingLabelId = null; // ポップアップで編集中のラベルID
  let pointerType = 'mouse';
  let lastTap = { id: null, time: 0 };
  let drag = null;           // { kind: 'label'|'anchor', label, anchorIndex, dx, dy, moved }
  let pan = null;            // 何もない所を押した時：{ x, y, panX, panY, point, moved }
  let pinch = null;          // 2本指：{ dist, zoom, imagePoint }
  const pointers = new Map(); // pointerId -> { x, y }
  const view = { base: 1, zoom: 1, panX: 0, panY: 0 }; // base: 全体表示の倍率（CSS px / 画像 px）
  let nextId = 1;
  const history = [];

  function defaultStyle(width) {
    return {
      fontSize: Math.max(10, Math.round(width * 0.0145)),
      labelColor: '#f5f0e8',
      labelOpacity: 0.9,
      textColor: '#2a2723',
      lineColor: '#ffffff',
      lineWidth: Math.max(1, Math.round(width / 900 * 2) / 2),
      lineShape: 'curve',
      dotSize: Math.max(2, Math.round(width / 400 * 2) / 2),
    };
  }

  // ---- 履歴 ----
  function snapshot() {
    return JSON.stringify({ labels, style, rotation });
  }
  function pushHistory() {
    history.push(snapshot());
    if (history.length > 100) history.shift();
    els.undoBtn.disabled = false;
  }
  function undo() {
    const prev = history.pop();
    if (!prev) return;
    const data = JSON.parse(prev);
    labels = data.labels;
    style = data.style;
    if ((data.rotation || 0) !== rotation) {
      rotation = data.rotation || 0;
      applyRotation();
    }
    if (!findLabel(selectedId)) selectedId = null;
    els.undoBtn.disabled = history.length === 0;
    syncStyleInputs();
    refresh();
  }

  // ---- ジオメトリ ----
  function findLabel(id) {
    return labels.find((l) => l.id === id) || null;
  }

  function fontString() {
    return `400 ${style.fontSize}px ${FONT_FAMILY}`;
  }

  function measureLabel(label) {
    ctx.font = fontString();
    const lines = (label.text || ' ').split('\n');
    const lineHeight = style.fontSize * 1.3;
    const textWidth = Math.max(...lines.map((t) => ctx.measureText(t).width));
    const padX = style.fontSize * 1.25;
    const padY = style.fontSize * 0.4;
    const w = textWidth + padX * 2;
    const h = lines.length * lineHeight + padY * 2;
    return {
      lines,
      lineHeight,
      w,
      h,
      left: label.x - w / 2,
      top: label.y - h / 2,
      radius: Math.min(h / 2, style.fontSize * 1.1),
    };
  }

  // ラベルから点への線の経路（始点・制御点・終点）
  function linePath(box, label, anchor) {
    const right = box.left + box.w;
    const bottom = box.top + box.h;
    let p0;
    let c1;
    let c2;
    const insideX = anchor.x >= box.left + box.radius && anchor.x <= right - box.radius;
    if (insideX && (anchor.y < box.top || anchor.y > bottom)) {
      // 真上・真下：上下の辺から出す
      const y0 = anchor.y > bottom ? bottom : box.top;
      p0 = { x: label.x, y: y0 };
      const my = (anchor.y - y0) / 2;
      c1 = { x: p0.x, y: y0 + my };
      c2 = { x: anchor.x, y: anchor.y - my };
    } else {
      // 左右の辺から横に出し、点へ回り込む
      const x0 = anchor.x < label.x ? box.left : right;
      p0 = { x: x0, y: label.y };
      c1 = { x: x0 + (anchor.x - x0) * 0.5, y: label.y };
      c2 = { x: anchor.x, y: anchor.y + (label.y - anchor.y) * 0.5 };
    }
    return { p0, c1, c2, p1: anchor };
  }

  function pointInBox(p, box) {
    return p.x >= box.left && p.x <= box.left + box.w && p.y >= box.top && p.y <= box.top + box.h;
  }

  function cssToImageScale() {
    const rect = canvas.getBoundingClientRect();
    return canvas.width / rect.width;
  }

  function eventToImage(e) {
    const rect = canvas.getBoundingClientRect();
    const s = canvas.width / rect.width;
    return { x: (e.clientX - rect.left) * s, y: (e.clientY - rect.top) * s };
  }

  function hitTest(p) {
    const tol = (HIT_TOLERANCE_CSS[pointerType] || HIT_TOLERANCE_CSS.mouse) * cssToImageScale();
    for (let i = labels.length - 1; i >= 0; i--) {
      const l = labels[i];
      for (let j = l.anchors.length - 1; j >= 0; j--) {
        const a = l.anchors[j];
        if (Math.hypot(a.x - p.x, a.y - p.y) <= Math.max(tol, style.dotSize * 1.5)) {
          return { kind: 'anchor', label: l, anchorIndex: j };
        }
      }
    }
    for (let i = labels.length - 1; i >= 0; i--) {
      const l = labels[i];
      if (pointInBox(p, measureLabel(l))) return { kind: 'label', label: l };
    }
    return null;
  }

  // ---- 表示サイズ・拡大縮小 ----
  // 画像の縦横比を保ったまま、PCでは作業領域いっぱいに、スマホでは画面幅いっぱいに表示する
  function fitCanvas() {
    if (!image) return;
    const wrap = els.canvasWrap;
    const mobile = MOBILE_QUERY.matches;
    if (!mobile) wrap.style.height = '';
    const availW = wrap.clientWidth;
    const availH = mobile ? window.innerHeight * 0.72 : wrap.clientHeight;
    if (!availW || !availH) return;
    view.base = Math.min(availW / canvas.width, availH / canvas.height);
    if (mobile) wrap.style.height = `${Math.floor(canvas.height * view.base)}px`;
    layoutCanvas();
  }

  // 拡大率とパン位置からキャンバスの表示位置を決める（はみ出さないように制限）
  function layoutCanvas() {
    const wrapW = els.canvasWrap.clientWidth;
    const wrapH = els.canvasWrap.clientHeight;
    const scale = view.base * view.zoom;
    const w = canvas.width * scale;
    const h = canvas.height * scale;
    const maxX = Math.max(0, (w - wrapW) / 2);
    const maxY = Math.max(0, (h - wrapH) / 2);
    view.panX = clamp(view.panX, -maxX, maxX);
    view.panY = clamp(view.panY, -maxY, maxY);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.style.left = `${(wrapW - w) / 2 + view.panX}px`;
    canvas.style.top = `${(wrapH - h) / 2 + view.panY}px`;
    els.zoomLevel.textContent = `${Math.round(view.zoom * 100)}%`;
    els.zoomOutBtn.disabled = view.zoom <= 1;
    els.zoomInBtn.disabled = view.zoom >= MAX_ZOOM;
    render();
  }

  // 画面上の点 (clientX, clientY) に画像上の imagePoint が来るように拡大率を変える
  function zoomTo(zoom, clientX, clientY, imagePoint) {
    const wrapRect = els.canvasWrap.getBoundingClientRect();
    view.zoom = clamp(zoom, 1, MAX_ZOOM);
    const scale = view.base * view.zoom;
    const left = clientX - wrapRect.left - imagePoint.x * scale;
    const top = clientY - wrapRect.top - imagePoint.y * scale;
    view.panX = left - (wrapRect.width - canvas.width * scale) / 2;
    view.panY = top - (wrapRect.height - canvas.height * scale) / 2;
    layoutCanvas();
  }

  function zoomAroundCenter(factor) {
    const wrapRect = els.canvasWrap.getBoundingClientRect();
    const cx = wrapRect.left + wrapRect.width / 2;
    const cy = wrapRect.top + wrapRect.height / 2;
    zoomTo(view.zoom * factor, cx, cy, eventToImage({ clientX: cx, clientY: cy }));
  }

  function resetView() {
    view.zoom = 1;
    view.panX = 0;
    view.panY = 0;
    layoutCanvas();
  }

  // ---- 回転 ----
  function applyRotation() {
    const w = sourceImage.naturalWidth;
    const h = sourceImage.naturalHeight;
    const swap = rotation % 180 !== 0;
    const off = document.createElement('canvas');
    off.width = swap ? h : w;
    off.height = swap ? w : h;
    const octx = off.getContext('2d');
    octx.translate(off.width / 2, off.height / 2);
    octx.rotate((rotation * Math.PI) / 180);
    octx.drawImage(sourceImage, -w / 2, -h / 2);
    image = off;
    canvas.width = off.width;
    canvas.height = off.height;
    view.zoom = 1;
    view.panX = 0;
    view.panY = 0;
    fitCanvas();
  }

  // dir: 1 = 時計回り, -1 = 反時計回り。ラベルと点も一緒に回す
  function rotateImage(dir) {
    if (!image) return;
    pushHistory();
    const w = canvas.width;
    const h = canvas.height;
    const turn = (p) => (dir > 0 ? { x: h - p.y, y: p.x } : { x: p.y, y: w - p.x });
    for (const l of labels) {
      Object.assign(l, turn(l));
      l.anchors = l.anchors.map(turn);
    }
    rotation = (rotation + dir * 90 + 360) % 360;
    closePopup();
    applyRotation();
    refresh();
  }

  // ---- 描画 ----
  function hexToRgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function render({ forExport = false } = {}) {
    if (!image) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);

    const boxes = new Map(labels.map((l) => [l.id, measureLabel(l)]));
    const shadowBlur = style.lineWidth * 2;

    // 線
    ctx.save();
    ctx.strokeStyle = style.lineColor;
    ctx.lineWidth = style.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = shadowBlur;
    for (const l of labels) {
      const box = boxes.get(l.id);
      for (const a of l.anchors) {
        const { p0, c1, c2, p1 } = linePath(box, l, a);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        if (style.lineShape === 'straight') {
          // 直線：ラベルから横（または縦）に出て、1回折れて点へ
          ctx.lineTo(c1.x, c1.y);
          ctx.lineTo(p1.x, p1.y);
        } else ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p1.x, p1.y);
        ctx.stroke();
      }
    }
    ctx.restore();

    // 点
    if (style.dotSize > 0) {
      ctx.save();
      ctx.fillStyle = style.lineColor;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = shadowBlur;
      for (const l of labels) {
        for (const a of l.anchors) {
          ctx.beginPath();
          ctx.arc(a.x, a.y, style.dotSize, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // ラベル
    for (const l of labels) {
      const box = boxes.get(l.id);
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.12)';
      ctx.shadowBlur = style.fontSize * 0.3;
      ctx.fillStyle = hexToRgba(style.labelColor, style.labelOpacity);
      roundRect(box.left, box.top, box.w, box.h, box.radius);
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = style.textColor;
      ctx.font = fontString();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const firstY = box.top + box.h / 2 - ((box.lines.length - 1) * box.lineHeight) / 2;
      box.lines.forEach((t, i) => ctx.fillText(t, l.x, firstY + i * box.lineHeight));

      if (!forExport && (l.id === selectedId || l.id === addingAnchorTo)) {
        ctx.save();
        const s = cssToImageScale();
        ctx.strokeStyle = '#3b6ea8';
        ctx.lineWidth = 2 * s;
        ctx.setLineDash([6 * s, 4 * s]);
        roundRect(box.left - 3 * s, box.top - 3 * s, box.w + 6 * s, box.h + 6 * s, box.radius + 3 * s);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 入力待ちのポイント
    if (!forExport && pendingPoint) {
      const s = cssToImageScale();
      ctx.save();
      ctx.fillStyle = '#3b6ea8';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.arc(pendingPoint.x, pendingPoint.y, 6 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---- UI 同期 ----
  function refresh() {
    render();
    renderList();
    renderEditor();
  }

  function renderList() {
    els.labelList.innerHTML = '';
    for (const l of labels) {
      const li = document.createElement('li');
      li.textContent = l.text.replace(/\n/g, ' ') || '（空のラベル）';
      if (l.id === selectedId) li.classList.add('selected');
      li.addEventListener('click', () => select(l.id));
      els.labelList.appendChild(li);
    }
  }

  function renderEditor() {
    const l = findLabel(selectedId);
    els.editor.hidden = !l;
    els.editorEmpty.hidden = !!l;
    if (!l) return;
    if (document.activeElement !== els.labelText) els.labelText.value = l.text;
    els.addAnchorBtn.classList.toggle('active', addingAnchorTo === l.id);
    els.addAnchorBtn.textContent = addingAnchorTo === l.id ? '画像上をクリック…' : '線を追加';
    els.removeAnchorBtn.disabled = l.anchors.length === 0;
  }

  function syncStyleInputs() {
    els.fontSize.value = style.fontSize;
    els.fontSizeOut.value = style.fontSize;
    els.labelColor.value = style.labelColor;
    els.labelOpacity.value = style.labelOpacity;
    els.textColor.value = style.textColor;
    els.lineColor.value = style.lineColor;
    els.lineWidth.value = style.lineWidth;
    els.lineShape.value = style.lineShape;
    els.dotSize.value = style.dotSize;
  }

  function select(id) {
    selectedId = id;
    if (addingAnchorTo !== id) addingAnchorTo = null;
    refresh();
  }

  // ---- ラベル作成 ----
  function placeLabelFor(point, text) {
    const label = { id: nextId++, text, x: 0, y: 0, anchors: [{ x: point.x, y: point.y }] };
    // 点に近い方の画像の端側へラベルを置く
    const offsetX = canvas.width * 0.12;
    const offsetY = canvas.height * 0.08;
    label.x = point.x < canvas.width / 2 ? point.x - offsetX : point.x + offsetX;
    label.y = point.y - offsetY;
    const box = measureLabel(label);
    const margin = style.fontSize * 0.5;
    label.x = clamp(label.x, box.w / 2 + margin, canvas.width - box.w / 2 - margin);
    label.y = clamp(label.y, box.h / 2 + margin, canvas.height - box.h / 2 - margin);
    // ラベルが点を覆ってしまう場合は上下にずらす
    const placed = measureLabel(label);
    if (pointInBox(point, placed)) {
      label.y = point.y > canvas.height / 2 ? point.y - placed.h * 1.5 : point.y + placed.h * 1.5;
    }
    return label;
  }

  function clamp(v, min, max) {
    return max < min ? (min + max) / 2 : Math.min(max, Math.max(min, v));
  }

  function openPopup(point, e, label = null) {
    pendingPoint = label ? null : point;
    editingLabelId = label ? label.id : null;
    els.popupOk.textContent = label ? '更新' : '追加';
    const wrapRect = els.canvasWrap.getBoundingClientRect();
    const popupW = 240;
    let left = e.clientX - wrapRect.left + 14;
    if (left + popupW > wrapRect.width) left = e.clientX - wrapRect.left - popupW - 14;
    let top = e.clientY - wrapRect.top - 20;
    top = clamp(top, 0, wrapRect.height - 110);
    els.popup.style.left = `${Math.max(0, left)}px`;
    els.popup.style.top = `${top}px`;
    els.popup.hidden = false;
    els.popupInput.value = label ? label.text : '';
    els.popupInput.focus();
    if (label) els.popupInput.select();
    render();
  }

  function closePopup() {
    pendingPoint = null;
    editingLabelId = null;
    els.popup.hidden = true;
    render();
  }

  function commitPopup() {
    const text = els.popupInput.value.trim();
    const editing = findLabel(editingLabelId);
    if (editing) {
      if (text && text !== editing.text) {
        pushHistory();
        editing.text = text;
      }
      closePopup();
      refresh();
      return;
    }
    if (!text || !pendingPoint) {
      closePopup();
      return;
    }
    pushHistory();
    const label = placeLabelFor(pendingPoint, text);
    labels.push(label);
    selectedId = label.id;
    closePopup();
    refresh();
  }

  // ---- ポインタ操作 ----
  canvas.addEventListener('pointerdown', (e) => {
    if (!image || e.button !== 0) return;
    pointerType = e.pointerType || 'mouse';
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      startPinch();
      return;
    }
    if (pointers.size > 2) return;
    if (!els.popup.hidden) {
      commitPopup();
      return;
    }
    const p = eventToImage(e);

    if (addingAnchorTo) {
      const l = findLabel(addingAnchorTo);
      if (l) {
        pushHistory();
        l.anchors.push(p);
      }
      addingAnchorTo = null;
      refresh();
      return;
    }

    const hit = hitTest(p);
    if (!hit) {
      // 離した時に動いていなければ入力、動いていれば表示を移動
      pan = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY, point: p, moved: false };
      return;
    }
    selectedId = hit.label.id;
    const target = hit.kind === 'anchor' ? hit.label.anchors[hit.anchorIndex] : hit.label;
    drag = { ...hit, dx: p.x - target.x, dy: p.y - target.y, moved: false };
    refresh();
  });

  function pinchInfo() {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function startPinch() {
    if (drag && drag.moved) renderList();
    drag = null;
    pan = null;
    const info = pinchInfo();
    pinch = { dist: info.dist, zoom: view.zoom, imagePoint: eventToImage({ clientX: info.x, clientY: info.y }) };
  }

  canvas.addEventListener('pointermove', (e) => {
    if (!image) return;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch) {
      if (pointers.size < 2) return;
      const info = pinchInfo();
      zoomTo(pinch.zoom * (info.dist / pinch.dist), info.x, info.y, pinch.imagePoint);
      return;
    }
    if (pan) {
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (!pan.moved && Math.hypot(dx, dy) < TAP_SLOP_CSS) return;
      pan.moved = true;
      view.panX = pan.panX + dx;
      view.panY = pan.panY + dy;
      layoutCanvas();
      return;
    }
    const p = eventToImage(e);
    if (!drag) {
      canvas.classList.toggle('over-item', !addingAnchorTo && !!hitTest(p));
      return;
    }
    if (!drag.moved) {
      pushHistory();
      drag.moved = true;
    }
    const target = drag.kind === 'anchor' ? drag.label.anchors[drag.anchorIndex] : drag.label;
    target.x = clamp(p.x - drag.dx, 0, canvas.width);
    target.y = clamp(p.y - drag.dy, 0, canvas.height);
    render();
  });

  // ラベルをダブルクリック／ダブルタップするとテキストを編集
  canvas.addEventListener('pointerup', (e) => {
    pointers.delete(e.pointerId);
    if (pinch) {
      // 2本指を離し終えるまでは何もしない
      if (pointers.size === 0) pinch = null;
      return;
    }
    if (pan) {
      const tap = !pan.moved;
      const point = pan.point;
      pan = null;
      if (tap) {
        selectedId = null;
        refresh();
        openPopup(point, e);
      }
      return;
    }
    if (drag && !drag.moved && drag.kind === 'label') {
      const now = Date.now();
      if (lastTap.id === drag.label.id && now - lastTap.time < DOUBLE_TAP_MS) {
        lastTap = { id: null, time: 0 };
        openPopup(null, e, drag.label);
      } else {
        lastTap = { id: drag.label.id, time: now };
      }
    }
    endDrag();
  });
  canvas.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) pinch = null;
    pan = null;
    endDrag();
  });

  canvas.addEventListener('wheel', (e) => {
    if (!image) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    zoomTo(view.zoom * factor, e.clientX, e.clientY, eventToImage(e));
  }, { passive: false });

  function endDrag() {
    if (drag) renderList();
    drag = null;
  }

  // ---- ポップアップ ----
  els.popupInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 日本語変換中のEnterは無視
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitPopup();
    } else if (e.key === 'Escape') {
      closePopup();
    }
  });
  els.popupOk.addEventListener('click', commitPopup);
  els.popupCancel.addEventListener('click', closePopup);

  // ---- エディタ ----
  let editingText = false;
  els.labelText.addEventListener('input', () => {
    const l = findLabel(selectedId);
    if (!l) return;
    if (!editingText) {
      pushHistory();
      editingText = true;
    }
    l.text = els.labelText.value;
    render();
    renderList();
  });
  els.labelText.addEventListener('blur', () => { editingText = false; });

  els.addAnchorBtn.addEventListener('click', () => {
    addingAnchorTo = addingAnchorTo === selectedId ? null : selectedId;
    refresh();
  });
  els.removeAnchorBtn.addEventListener('click', () => {
    const l = findLabel(selectedId);
    if (!l || !l.anchors.length) return;
    pushHistory();
    l.anchors.pop();
    refresh();
  });
  els.deleteLabelBtn.addEventListener('click', deleteSelected);

  function deleteSelected() {
    if (!findLabel(selectedId)) return;
    pushHistory();
    labels = labels.filter((l) => l.id !== selectedId);
    selectedId = null;
    addingAnchorTo = null;
    refresh();
  }

  // ---- スタイル ----
  const styleInputs = [
    ['fontSize', Number],
    ['labelColor', String],
    ['labelOpacity', Number],
    ['textColor', String],
    ['lineColor', String],
    ['lineWidth', Number],
    ['lineShape', String],
    ['dotSize', Number],
  ];
  for (const [key, cast] of styleInputs) {
    let editing = false;
    els[key].addEventListener('input', () => {
      if (!editing) {
        pushHistory();
        editing = true;
      }
      style[key] = cast(els[key].value);
      if (key === 'fontSize') els.fontSizeOut.value = style.fontSize;
      render();
    });
    els[key].addEventListener('change', () => {
      editing = false;
      style[key] = cast(els[key].value);
      render();
    });
  }

  // ---- キーボード ----
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    if (e.key === 'Escape') {
      addingAnchorTo = null;
      selectedId = null;
      refresh();
      return;
    }
    const l = findLabel(selectedId);
    if (!l) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelected();
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      pushHistory();
      l.x += moves[e.key][0];
      l.y += moves[e.key][1];
      render();
    }
  });

  // ---- 画像の読み込み ----
  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function openImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const src = await readAsDataURL(file);
    const img = await loadImage(src);
    if (labels.length && !confirm('現在のラベルを破棄して新しい画像を開きますか？')) return;
    imageName = (file.name || 'desk').replace(/\.[^.]+$/, '') || 'desk';
    rotation = 0;
    setImage(img, src);
    labels = [];
    history.length = 0;
    els.undoBtn.disabled = true;
    style = defaultStyle(img.naturalWidth);
    syncStyleInputs();
    selectedId = null;
    refresh();
  }

  function setImage(img, src) {
    sourceImage = img;
    imageSrc = src;
    els.dropzone.hidden = true;
    els.canvasWrap.hidden = false;
    els.hint.hidden = false;
    els.exportBtn.disabled = false;
    els.saveProjectBtn.disabled = false;
    els.undoBtn.disabled = true;
    addingAnchorTo = null;
    closePopup();
    applyRotation();
    requestAnimationFrame(fitCanvas);
  }

  els.fileInput.addEventListener('change', () => {
    openImageFile(els.fileInput.files[0]);
    els.fileInput.value = '';
  });
  els.dropzone.addEventListener('click', () => els.fileInput.click());

  ['dragenter', 'dragover'].forEach((type) =>
    els.stage.addEventListener(type, (e) => {
      e.preventDefault();
      els.dropzone.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((type) =>
    els.stage.addEventListener(type, () => els.dropzone.classList.remove('over'))
  );
  els.stage.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (file.name.endsWith('.json')) openProjectFile(file);
    else openImageFile(file);
  });

  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith('image/'));
    if (item) openImageFile(item.getAsFile());
  });

  // ---- 書き出し・保存 ----
  function download(blobOrUrl, filename) {
    const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (typeof blobOrUrl !== 'string') setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  els.exportBtn.addEventListener('click', () => {
    render({ forExport: true });
    canvas.toBlob((blob) => {
      download(blob, `${imageName}-recipe.png`);
      render();
    }, 'image/png');
  });

  els.saveProjectBtn.addEventListener('click', () => {
    const data = { app: 'DeskRecipeManager', version: 1, imageName, imageSrc, rotation, style, labels };
    download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `${imageName}-recipe.json`);
  });

  async function openProjectFile(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!data.imageSrc || !Array.isArray(data.labels)) throw new Error('invalid');
      const img = await loadImage(data.imageSrc);
      imageName = data.imageName || 'desk';
      rotation = [0, 90, 180, 270].includes(data.rotation) ? data.rotation : 0;
      setImage(img, data.imageSrc);
      labels = data.labels;
      style = { ...defaultStyle(img.naturalWidth), ...data.style };
      nextId = labels.reduce((m, l) => Math.max(m, l.id), 0) + 1;
      history.length = 0;
      selectedId = null;
      syncStyleInputs();
      refresh();
    } catch (err) {
      alert('プロジェクトファイルを読み込めませんでした。');
    }
  }

  els.projectInput.addEventListener('change', () => {
    if (els.projectInput.files[0]) openProjectFile(els.projectInput.files[0]);
    els.projectInput.value = '';
  });

  // ---- 画面まわり ----
  els.undoBtn.addEventListener('click', undo);
  els.zoomInBtn.addEventListener('click', () => zoomAroundCenter(1.5));
  els.zoomOutBtn.addEventListener('click', () => zoomAroundCenter(1 / 1.5));
  els.zoomFitBtn.addEventListener('click', resetView);
  els.rotateLeftBtn.addEventListener('click', () => rotateImage(-1));
  els.rotateRightBtn.addEventListener('click', () => rotateImage(1));

  els.panelToggleBtn.addEventListener('click', () => {
    const hidden = els.app.classList.toggle('panel-hidden');
    els.panelToggleBtn.textContent = hidden ? 'パネルを表示' : 'パネルを隠す';
    fitCanvas();
  });

  if (!document.fullscreenEnabled) els.fullscreenBtn.hidden = true;
  els.fullscreenBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else els.app.requestFullscreen();
  });
  document.addEventListener('fullscreenchange', () => {
    els.fullscreenBtn.textContent = document.fullscreenElement ? '全画面を終了' : '全画面';
    requestAnimationFrame(fitCanvas);
  });

  new ResizeObserver(() => fitCanvas()).observe(els.stage);
  window.addEventListener('resize', fitCanvas);

  syncStyleInputs();
  refresh();
})();
