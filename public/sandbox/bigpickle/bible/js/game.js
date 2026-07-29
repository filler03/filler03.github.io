const Game = (() => {
  const NEON_COLORS = [
    '#00f5ff', '#ff00e4', '#ffe600',
    '#39ff14', '#ff6a00', '#b300ff'
  ];

  let verseData = null;
  let words = [];
  let placedWords = [];
  let nextSlotIdx = 0;

  let cameraX = 0;
  let cameraY = 0;
  let worldW = 0;
  let worldH = 0;

  let gameCanvas, gameCtx;
  let particleCanvas, particleCtx;
  let particles = [];
  let animFrame = null;

  let wordElements = [];
  let wordWorldPos = [];
  let animCount = 0;
  let wordsPlaced = [];

  let dragIdx = -1;
  let placingIdxs = new Set();
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let dragStartScreenX = 0;
  let dragStartScreenY = 0;
  let dragMoved = false;

  let panActive = false;
  let panStartX = 0;
  let panStartY = 0;
  let panStartCamX = 0;
  let panStartCamY = 0;
  let cameraDirty = true;
  let cachedHeaderH = 0;
  let nextZIndex = 21;

  const $ = (id) => document.getElementById(id);

  function init(verse) {
    verseData = verse;
    words = verse.text.split(/\s+/).filter(w => w.length > 0);
    placedWords = new Array(words.length).fill(false);
    wordsPlaced = new Array(words.length).fill(false);
    nextSlotIdx = 0;
    dragIdx = -1;
    placingIdxs = new Set();
    panActive = false;

    gameCanvas = $('game-canvas');
    particleCanvas = $('particle-canvas');
    gameCtx = gameCanvas.getContext('2d');
    particleCtx = particleCanvas.getContext('2d');

    resizeCanvases();
    window.addEventListener('resize', resizeCanvases);

    buildVerseSlots();
    scatterWords();
    setupPan();
    setupWordDrag();
    setupBackButton();
    startLoop();
  }

  function resizeCanvases() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    gameCanvas.width = w;
    gameCanvas.height = h;
    particleCanvas.width = w;
    particleCanvas.height = h;
  }

  function buildVerseSlots() {
    const container = $('verse-slots');
    container.innerHTML = '';
    container.classList.toggle('hints-hidden', !verseData.showHints);
    $('verse-ref').textContent = `${verseData.bookName} ${verseData.chapter}:${verseData.verse} · ${verseData.version.toUpperCase()}`;

    words.forEach((word, i) => {
      const slot = document.createElement('div');
      slot.className = 'word-slot';
      slot.dataset.idx = i;
      slot.textContent = word;
      const color = NEON_COLORS[i % NEON_COLORS.length];
      slot.style.borderColor = color + '60';
      container.appendChild(slot);
    });

    updateNextTarget();
  }

  function updateNextTarget() {
    const slots = document.querySelectorAll('.word-slot');
    slots.forEach((s, i) => {
      const color = NEON_COLORS[i % NEON_COLORS.length];
      const isNext = !verseData.anyOrder && i === nextSlotIdx && !placedWords[i];
      s.classList.toggle('next-target', isNext);
      if (isNext) {
        s.style.borderColor = color;
        s.style.boxShadow = `0 0 10px ${color}33`;
      } else if (!placedWords[i]) {
        s.style.borderColor = color + '60';
        s.style.boxShadow = '';
      }
    });
  }

  const WORD_THRESHOLD = 20;
  const SCALE_PER_EXTRA = 1.05;

  function scatterWords() {
    wordElements.forEach(el => el.remove());
    wordElements = [];
    wordWorldPos = [];

    const headerH = document.querySelector('.game-header').getBoundingClientRect().height;

    const playW = window.innerWidth;
    const playH = window.innerHeight - headerH;

    let w = playW;
    let h = playH;
    if (words.length > WORD_THRESHOLD) {
      const excess = words.length - WORD_THRESHOLD;
      const factor = Math.pow(SCALE_PER_EXTRA, excess);
      w *= factor;
      h *= factor;
    }

    w *= verseData.spread;
    h *= verseData.spread;

    worldW = Math.max(w, window.innerWidth);
    worldH = Math.max(h, window.innerHeight);
    cameraX = (worldW - window.innerWidth) / 2;
    cameraY = (worldH - window.innerHeight) / 2;

    words.forEach((word, i) => {
      const el = document.createElement('div');
      el.className = 'word-tile';
      el.textContent = word;
      el.dataset.idx = i;
      el.style.left = '0px';
      el.style.top = '0px';
      document.getElementById('game-screen').appendChild(el);
      wordElements.push(el);
    });

    const minY = headerH;
    words.forEach((word, i) => {
      const el = wordElements[i];
      const tw = el.offsetWidth;
      const th = el.offsetHeight;
      const x = Math.random() * (worldW - tw);
      const y = minY + Math.random() * Math.max(0, worldH - minY - th);
      wordWorldPos.push({ x, y });
      el.style.left = x + 'px';
      el.style.top = y + 'px';

      const color = NEON_COLORS[i % NEON_COLORS.length];
      el.style.borderColor = color + '80';
      el.style.color = color;
      el.style.textShadow = `0 0 6px ${color}`;
      el.style.boxShadow = `0 0 12px ${color}40`;
    });

    let needExpand = true;
    while (needExpand) {
      needExpand = false;
      wordElements.forEach((el, i) => {
        const tw = el.offsetWidth;
        const th = el.offsetHeight;
        const pos = wordWorldPos[i];
        const overRight = pos.x + tw - worldW;
        const overBottom = pos.y + th - worldH;
        const overLeft = -pos.x;
        const overTop = -pos.y;
        if (overRight > 0) { worldW += overRight; needExpand = true; }
        if (overBottom > 0) { worldH += overBottom; needExpand = true; }
        if (overLeft > 0) { wordWorldPos.forEach(p => p.x += overLeft); worldW += overLeft; needExpand = true; }
        if (overTop > 0) { wordWorldPos.forEach(p => p.y += overTop); worldH += overTop; needExpand = true; }
      });
      if (needExpand) {
        wordElements.forEach((el, i) => {
          el.style.left = wordWorldPos[i].x + 'px';
          el.style.top = wordWorldPos[i].y + 'px';
        });
      }
    }
  }

  /* ---- PAN (drag on empty canvas) ---- */
  function setupPan() {
    gameCanvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      panActive = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panStartCamX = cameraX;
      panStartCamY = cameraY;
      gameCanvas.style.cursor = 'grabbing';
    });

    gameCanvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.touches[0];
      panActive = true;
      panStartX = t.clientX;
      panStartY = t.clientY;
      panStartCamX = cameraX;
      panStartCamY = cameraY;
    }, { passive: false });

    boundPanMove = (e) => {
      if (!panActive || dragIdx >= 0) return;
      if (e.cancelable) e.preventDefault();
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      const cy = e.touches ? e.touches[0].clientY : e.clientY;

      cameraX = panStartCamX - (cx - panStartX);
      cameraY = panStartCamY - (cy - panStartY);
      cameraX = Math.max(0, Math.min(cameraX, worldW - window.innerWidth));
      cameraY = Math.max(0, Math.min(cameraY, worldH - window.innerHeight));
      cameraDirty = true;
    };

    boundPanEnd = () => {
      if (dragIdx < 0) panActive = false;
      gameCanvas.style.cursor = '';
    };

    window.addEventListener('mousemove', boundPanMove);
    window.addEventListener('touchmove', boundPanMove, { passive: false });
    window.addEventListener('mouseup', boundPanEnd);
    window.addEventListener('touchend', boundPanEnd);
  }

  /* ---- WORD DRAG AND DROP ---- */
  function setupWordDrag() {
    wordElements.forEach((el, i) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startWordDrag(i, e.clientX, e.clientY);
      });

      el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const t = e.touches[0];
        startWordDrag(i, t.clientX, t.clientY);
      }, { passive: false });
    });

    boundDragMove = (e) => {
      if (dragIdx < 0) return;
      if (e.cancelable) e.preventDefault();
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      const cy = e.touches ? e.touches[0].clientY : e.clientY;
      onWordDragMove(cx, cy);
    };
    boundDragEndMouse = (e) => endWordDrag(e.clientX, e.clientY);
    boundDragEndTouch = (e) => {
      const t = e.changedTouches[0];
      endWordDrag(t.clientX, t.clientY);
    };

    window.addEventListener('mousemove', boundDragMove);
    window.addEventListener('mouseup', boundDragEndMouse);
    window.addEventListener('touchmove', boundDragMove, { passive: false });
    window.addEventListener('touchend', boundDragEndTouch);
  }

  function startWordDrag(idx, cx, cy) {
    if (wordsPlaced[idx] || placingIdxs.has(idx)) return;
    dragIdx = idx;
    dragMoved = false;
    dragStartScreenX = cx;
    dragStartScreenY = cy;

    const el = wordElements[idx];
    const screenX = wordWorldPos[idx].x - cameraX;
    const screenY = wordWorldPos[idx].y - cameraY;
    dragOffsetX = cx - screenX;
    dragOffsetY = cy - screenY;

    el.style.zIndex = nextZIndex++;
    el.classList.add('dragging');
  }

  function onWordDragMove(cx, cy) {
    if (dragIdx < 0) return;

    const dx = cx - dragStartScreenX;
    const dy = cy - dragStartScreenY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragMoved = true;

    const el = wordElements[dragIdx];
    el.style.zIndex = nextZIndex++;
    el.style.left = (cx - dragOffsetX) + 'px';
    el.style.top = (cy - dragOffsetY) + 'px';

    highlightDropTarget(cx, cy);
  }

  function isInVerseArea(cx, cy) {
    const header = document.querySelector('.game-header');
    const r = header.getBoundingClientRect();
    return cy <= r.bottom + 50;
  }

  function endWordDrag(cx, cy) {
    if (dragIdx < 0) return;

    const el = wordElements[dragIdx];
    el.classList.remove('dragging');

    const slotIdx = getSlotUnderPoint(cx, cy);
    clearDropHighlights();

    const isCorrect = verseData.anyOrder
      ? (slotIdx >= 0 && !placedWords[slotIdx] && words[dragIdx] === words[slotIdx])
      : (slotIdx >= 0 && slotIdx === nextSlotIdx && words[dragIdx] === words[slotIdx]);

    if (isCorrect) {
      const savedDragIdx = dragIdx;
      dragIdx = -1;
      placeWord(savedDragIdx, slotIdx);
    } else if (isInVerseArea(cx, cy)) {
      el.style.transition = 'left 0.25s ease, top 0.25s ease';
      const wx = wordWorldPos[dragIdx].x - cameraX;
      const wy = wordWorldPos[dragIdx].y - cameraY;
      el.style.left = wx + 'px';
      el.style.top = wy + 'px';
      setTimeout(() => { el.style.transition = ''; }, 260);
    } else {
      const dropScreenX = parseFloat(el.style.left);
      const dropScreenY = parseFloat(el.style.top);
      wordWorldPos[dragIdx].x = dropScreenX + cameraX;
      wordWorldPos[dragIdx].y = dropScreenY + cameraY;
    }

    dragIdx = -1;
  }

  function getSlotUnderPoint(cx, cy) {
    const pad = 30;
    const slots = document.querySelectorAll('.word-slot');
    for (let i = 0; i < slots.length; i++) {
      if (placedWords[i]) continue;
      const r = slots[i].getBoundingClientRect();
      if (cx >= r.left - pad && cx <= r.right + pad && cy >= r.top - pad && cy <= r.bottom + pad) {
        return i;
      }
    }
    return -1;
  }

  function highlightDropTarget(cx, cy) {
    clearDropHighlights();
    const slotIdx = getSlotUnderPoint(cx, cy);
    if (slotIdx >= 0 && dragIdx >= 0 && words[dragIdx] === words[slotIdx] && !placedWords[slotIdx]) {
      if (verseData.anyOrder || slotIdx === nextSlotIdx) {
        document.querySelectorAll('.word-slot')[slotIdx].classList.add('drop-hover');
      }
    }
  }

  function clearDropHighlights() {
    document.querySelectorAll('.word-slot.drop-hover').forEach(s => s.classList.remove('drop-hover'));
  }

  function placeWord(wordIdx, slotIdx) {
    const el = wordElements[wordIdx];
    const slot = document.querySelectorAll('.word-slot')[slotIdx];

    const slotRect = slot.getBoundingClientRect();
    const targetX = slotRect.left + slotRect.width / 2;
    const targetY = slotRect.top + slotRect.height / 2;

    animCount++;
    placingIdxs.add(wordIdx);

    const startX = parseFloat(el.style.left) || (wordWorldPos[wordIdx].x - cameraX);
    const startY = parseFloat(el.style.top) || (wordWorldPos[wordIdx].y - cameraY);

    animateWordToSlot(el, startX, startY, targetX, targetY, () => {
      el.style.display = 'none';
      slot.classList.add('filled');
      const color = NEON_COLORS[slotIdx % NEON_COLORS.length];
      slot.style.borderColor = color + '80';
      slot.style.color = color;
      slot.style.textShadow = `0 0 6px ${color}`;
      placedWords[slotIdx] = true;
      wordsPlaced[wordIdx] = true;
      nextSlotIdx = findNextSlot();
      animCount--;
      placingIdxs.delete(wordIdx);

      spawnPlacementBurst(targetX, targetY);

      if (nextSlotIdx >= 0) {
    updateNextTarget();

    requestAnimationFrame(() => {
      document.querySelectorAll('.word-slot').forEach(s => {
        s.style.width = s.offsetWidth + 'px';
      });
    });
      } else {
        onVerseComplete();
      }
    });
  }

  function animateWordToSlot(el, fromX, fromY, toX, toY, onDone, duration) {
    if (duration === undefined) duration = 500;
    const start = performance.now();

    function tick(now) {
      const t = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);

      const x = fromX + (toX - fromX) * ease;
      const y = fromY + (toY - fromY) * ease;
      const scale = 1 + 0.3 * Math.sin(t * Math.PI);

      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.transform = `scale(${scale})`;
      el.style.opacity = 1 - t * 0.3;

      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        onDone();
      }
    }
    requestAnimationFrame(tick);
  }

  function findNextSlot() {
    for (let i = 0; i < words.length; i++) {
      if (!placedWords[i]) return i;
    }
    return -1;
  }

  function spawnPlacementBurst(x, y) {
    const color = NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)];
    for (let i = 0; i < 30; i++) {
      const angle = (Math.PI * 2 * i) / 30 + Math.random() * 0.3;
      const speed = 2 + Math.random() * 4;
      particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        decay: 0.015 + Math.random() * 0.01,
        size: 2 + Math.random() * 4,
        color
      });
    }
  }

  function spawnCelebration() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (let i = 0; i < 120; i++) {
      const color = NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)];
      particles.push({
        x: Math.random() * w,
        y: -20 - Math.random() * 200,
        vx: (Math.random() - 0.5) * 3,
        vy: 1 + Math.random() * 3,
        life: 1,
        decay: 0.005 + Math.random() * 0.005,
        size: 3 + Math.random() * 5,
        color
      });
    }
  }

  function autoComplete() {
    if (animCount > 0) return;

    const speedMap = {
      slow: { duration: 800, overlapDelay: 250 },
      normal: { duration: 500, overlapDelay: 150 },
      fast: { duration: 320, overlapDelay: 80 }
    };
    const speed = speedMap[verseData.autoSpeed || 'normal'];

    const unplacedWords = [];
    for (let j = 0; j < words.length; j++) {
      if (!wordsPlaced[j]) unplacedWords.push(j);
    }
    if (unplacedWords.length === 0) return;

    const queue = [];
    for (let i = 0; i < words.length; i++) {
      if (placedWords[i]) continue;
      const wordIdx = unplacedWords.find(j => words[j] === words[i]);
      if (wordIdx === undefined) continue;
      queue.push({ slotIdx: i, wordIdx });
      unplacedWords.splice(unplacedWords.indexOf(wordIdx), 1);
    }

    let qi = 0;
    let done = false;

    function placeNext() {
      if (qi >= queue.length) {
        if (!done && animCount <= 0 && findNextSlot() < 0) {
          done = true;
          onVerseComplete();
        }
        return;
      }

      const { slotIdx, wordIdx } = queue[qi++];
      const el = wordElements[wordIdx];
      const slot = document.querySelectorAll('.word-slot')[slotIdx];
      if (!el || !slot) { placeNext(); return; }

      slot.scrollIntoView({ block: 'center' });
      const slotRect = slot.getBoundingClientRect();
      const targetX = slotRect.left + slotRect.width / 2;
      const targetY = slotRect.top + slotRect.height / 2;
      const startX = parseFloat(el.style.left) || (wordWorldPos[wordIdx].x - cameraX);
      const startY = parseFloat(el.style.top) || (wordWorldPos[wordIdx].y - cameraY);

      animCount++;
      placingIdxs.add(wordIdx);
      el.style.zIndex = nextZIndex++;

      if (qi < queue.length) {
        setTimeout(placeNext, speed.overlapDelay);
      }

      animateWordToSlot(el, startX, startY, targetX, targetY, () => {
        el.style.display = 'none';
        slot.classList.add('filled');
        const color = NEON_COLORS[slotIdx % NEON_COLORS.length];
        slot.style.borderColor = color + '80';
        slot.style.color = color;
        slot.style.textShadow = `0 0 6px ${color}`;
        placedWords[slotIdx] = true;
        wordsPlaced[wordIdx] = true;
        nextSlotIdx = findNextSlot();

        spawnPlacementBurst(targetX, targetY);
        updateNextTarget();

        requestAnimationFrame(() => {
          document.querySelectorAll('.word-slot').forEach(s => {
            s.style.width = s.offsetWidth + 'px';
          });
        });

        animCount--;
        placingIdxs.delete(wordIdx);

        if (!done && animCount <= 0 && nextSlotIdx < 0) {
          done = true;
          onVerseComplete();
        }
      }, speed.duration);
    }

    placeNext();
  }

  function onVerseComplete() {
    spawnCelebration();
    setTimeout(() => {
      $('celebration-verse').textContent = `"${verseData.text}"`;
      $('celebration-overlay').classList.remove('hidden');
      document.querySelector('.game-header').classList.add('expanded');
      spawnCelebration();
    }, 800);
  }

  function setupBackButton() {
    $('auto-btn').onclick = autoComplete;
    $('back-btn').onclick = () => {
      const currentRef = {
        version: verseData.version,
        book: verseData.bookSlug,
        bookName: verseData.bookName,
        chapter: verseData.chapter,
        verse: verseData.verse,
        spread: verseData.spread,
        autoSpeed: verseData.autoSpeed
      };
      cleanup();
      App.showSetup(currentRef);
    };
    $('next-verse-btn').onclick = () => {
      const currentRef = {
        version: verseData.version,
        book: verseData.bookSlug,
        bookName: verseData.bookName,
        chapter: verseData.chapter,
        verse: verseData.verse,
        spread: verseData.spread,
        showHints: verseData.showHints,
        autoSpeed: verseData.autoSpeed
      };
      cleanup();
      App.startNextVerse(currentRef);
    };
  }

  let boundDragMove = null;
  let boundDragEndMouse = null;
  let boundDragEndTouch = null;
  let boundPanMove = null;
  let boundPanEnd = null;

  /* ---- RENDER LOOP ---- */
  function startLoop() {
    function loop() {
      render();
      renderParticles();
      animFrame = requestAnimationFrame(loop);
    }
    animFrame = requestAnimationFrame(loop);
  }

  function render() {
    gameCtx.clearRect(0, 0, gameCanvas.width, gameCanvas.height);

    gameCtx.fillStyle = 'rgba(10, 10, 26, 1)';
    gameCtx.fillRect(0, 0, gameCanvas.width, gameCanvas.height);

    if (cameraDirty) {
      cachedHeaderH = document.querySelector('.game-header').getBoundingClientRect().height;
    }
    drawGrid();
    drawOffscreenArrows();

    if (!cameraDirty) return;
    cameraDirty = false;

    wordElements.forEach((el, i) => {
      if (wordsPlaced[i]) return;
      if (i === dragIdx) return;
      if (placingIdxs.has(i)) return;

      const wx = wordWorldPos[i].x;
      const wy = wordWorldPos[i].y;
      const sx = wx - cameraX;
      const sy = wy - cameraY;

      const margin = 80;
      if (sx < -margin || sx > gameCanvas.width + margin ||
          sy < -margin || sy > gameCanvas.height + margin) {
        el.style.display = 'none';
      } else {
        el.style.display = 'block';
        el.style.left = sx + 'px';
        el.style.top = sy + 'px';
      }
    });
  }

  function drawGrid() {
    gameCtx.strokeStyle = 'rgba(0, 245, 255, 0.03)';
    gameCtx.lineWidth = 1;
    const gridSize = 60;
    const offsetX = -(cameraX % gridSize);
    const offsetY = -(cameraY % gridSize);

    for (let x = offsetX; x < gameCanvas.width; x += gridSize) {
      gameCtx.beginPath();
      gameCtx.moveTo(x, 0);
      gameCtx.lineTo(x, gameCanvas.height);
      gameCtx.stroke();
    }
    for (let y = offsetY; y < gameCanvas.height; y += gridSize) {
      gameCtx.beginPath();
      gameCtx.moveTo(0, y);
      gameCtx.lineTo(gameCanvas.width, y);
      gameCtx.stroke();
    }
  }

  function drawOffscreenArrows() {
    const w = gameCanvas.width;
    const h = gameCanvas.height;
    const edgePad = 15;
    const arrowSize = 10;

    wordElements.forEach((el, i) => {
      if (wordsPlaced[i]) return;
      if (i === dragIdx) return;
      if (placingIdxs.has(i)) return;

      const sx = wordWorldPos[i].x - cameraX;
      const sy = wordWorldPos[i].y - cameraY;

      const headerH = cachedHeaderH;
      const topEdge = headerH + 15;

      const offScreen = sx < -80 || sx > w + 80 || sy < -80 || sy > h + 80;
      const behindHeader = sy < topEdge && sx > -80 && sx < w + 80;
      if (!offScreen && !behindHeader) return;

      const color = NEON_COLORS[i % NEON_COLORS.length];

      const clampedX = Math.max(0, Math.min(w, sx));
      const clampedY = Math.max(topEdge, Math.min(h, sy));

      let ax, ay, angle;
      if (clampedX <= 0) { ax = edgePad; ay = clampedY; angle = Math.PI; }
      else if (clampedX >= w) { ax = w - edgePad; ay = clampedY; angle = 0; }
      else if (clampedY <= topEdge) { ax = clampedX; ay = topEdge; angle = Math.PI * 1.5; }
      else { ax = clampedX; ay = h - edgePad; angle = Math.PI * 0.5; }

      const wiggle = Math.sin(Date.now() / 150 + i * 2.5) * 0.25;

      gameCtx.save();
      gameCtx.translate(ax, ay);
      gameCtx.rotate(angle + wiggle);
      gameCtx.fillStyle = color;
      gameCtx.globalAlpha = 0.7 + Math.sin(Date.now() / 300 + i) * 0.3;
      gameCtx.beginPath();
      gameCtx.moveTo(arrowSize, 0);
      gameCtx.lineTo(-arrowSize * 0.6, -arrowSize * 0.6);
      gameCtx.lineTo(-arrowSize * 0.6, arrowSize * 0.6);
      gameCtx.closePath();
      gameCtx.fill();
      gameCtx.restore();
    });
    gameCtx.globalAlpha = 1;
  }

  function renderParticles() {
    particleCtx.clearRect(0, 0, particleCanvas.width, particleCanvas.height);

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.02;
      p.life -= p.decay;

      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }

      particleCtx.globalAlpha = p.life;
      particleCtx.fillStyle = p.color;
      particleCtx.shadowColor = p.color;
      particleCtx.shadowBlur = 10;

      particleCtx.beginPath();
      particleCtx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      particleCtx.fill();
    }

    particleCtx.globalAlpha = 1;
    particleCtx.shadowBlur = 0;
  }

  function cleanup() {
    if (animFrame) cancelAnimationFrame(animFrame);
    window.removeEventListener('resize', resizeCanvases);
    if (boundDragMove) window.removeEventListener('mousemove', boundDragMove);
    if (boundDragEndMouse) window.removeEventListener('mouseup', boundDragEndMouse);
    if (boundDragMove) window.removeEventListener('touchmove', boundDragMove);
    if (boundDragEndTouch) window.removeEventListener('touchend', boundDragEndTouch);
    if (boundPanMove) window.removeEventListener('mousemove', boundPanMove);
    if (boundPanMove) window.removeEventListener('touchmove', boundPanMove);
    if (boundPanEnd) window.removeEventListener('mouseup', boundPanEnd);
    if (boundPanEnd) window.removeEventListener('touchend', boundPanEnd);
    boundDragMove = null;
    boundDragEndMouse = null;
    boundDragEndTouch = null;
    boundPanMove = null;
    boundPanEnd = null;
    wordElements.forEach(el => el.remove());
    wordElements = [];
    wordWorldPos = [];
    particles = [];
    $('verse-slots').innerHTML = '';
    $('celebration-overlay').classList.add('hidden');
    document.querySelector('.game-header').classList.remove('expanded');
  }

  return { init, cleanup };
})();
