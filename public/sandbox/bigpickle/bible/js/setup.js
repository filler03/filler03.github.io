const Setup = (() => {
  let selectedTranslation = 'esv';
  let allBooks = [];
  let selectedBook = null;
  let selectedChapter = null;
  let selectedVerse = null;
  let chapterCount = 0;
  let verseCount = 0;
  let spread = 1;

  const $ = (id) => document.getElementById(id);

  function init() {
    bindTranslationButtons();
    loadBooks().then(() => selectGenesis());
    bindDropdowns();
    bindStartButton();
    bindSpreadSlider();
    generateStars();
  }

  async function selectGenesis() {
    const genesis = allBooks.find(b => b.slug.en === 'genesis');
    if (!genesis) return;
    selectedBook = genesis;
    $('book-search').value = `${genesis.name.en} (OT)`;
    await autoSelectChapter1();
  }

  function generateStars() {
    const container = $('stars');
    for (let i = 0; i < 80; i++) {
      const star = document.createElement('div');
      star.style.cssText = `
        position: absolute;
        width: ${Math.random() * 2 + 1}px;
        height: ${Math.random() * 2 + 1}px;
        background: white;
        border-radius: 50%;
        top: ${Math.random() * 100}%;
        left: ${Math.random() * 100}%;
        opacity: ${Math.random() * 0.5 + 0.1};
        animation: twinkle ${Math.random() * 3 + 2}s ease-in-out infinite ${Math.random() * 3}s;
      `;
      container.appendChild(star);
    }
    const style = document.createElement('style');
    style.textContent = `
      @keyframes twinkle {
        0%, 100% { opacity: 0.1; }
        50% { opacity: 0.6; }
      }
    `;
    document.head.appendChild(style);
  }

  function bindTranslationButtons() {
    const buttons = document.querySelectorAll('.trans-btn');
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedTranslation = btn.dataset.slug;
        if (selectedBook && selectedChapter && selectedVerse) {
          previewVerse();
        }
      });
    });
  }

  async function loadBooks() {
    try {
      allBooks = await BibleAPI.getBooks();
      allBooks.sort((a, b) => a.id - b.id);
    } catch (e) {
      console.error('Failed to load books:', e);
    }
  }

  function bindDropdowns() {
    setupDropdown('book-search', 'book-dropdown', () => {
      return allBooks.map(b => ({
        label: `${b.name.en} (${b.testament === 'old' ? 'OT' : 'NT'})`,
        value: b.slug.en,
        data: b
      }));
    }, (item) => {
      selectedBook = item.data;
      $('book-search').value = item.label;
      $('book-dropdown').classList.add('hidden');
      autoSelectChapter1();
    });

    setupDropdown('chapter-search', 'chapter-dropdown', () => {
      const items = [];
      for (let i = 1; i <= chapterCount; i++) {
        items.push({ label: String(i), value: i });
      }
      return items;
    }, (item) => {
      selectedChapter = item.value;
      $('chapter-search').value = item.label;
      $('chapter-dropdown').classList.add('hidden');
      $('verse-search').disabled = false;
      selectedVerse = 1;
      $('verse-search').value = '1';
      previewVerse();
      loadVerseCount();
    });

    setupDropdown('verse-search', 'verse-dropdown', () => {
      const items = [];
      for (let i = 1; i <= verseCount; i++) {
        items.push({ label: String(i), value: i });
      }
      return items;
    }, (item) => {
      selectedVerse = item.value;
      $('verse-search').value = item.label;
      $('verse-dropdown').classList.add('hidden');
      previewVerse();
    });
  }

  function setupDropdown(inputId, dropdownId, getItems, onSelect) {
    const input = $(inputId);
    const dropdown = $(dropdownId);
    let items = [];
    let filtered = [];
    let highlightIdx = -1;

    input.addEventListener('focus', () => {
      items = getItems();
      filtered = [...items];
      highlightIdx = -1;
      renderItems();
      dropdown.classList.remove('hidden');
    });

    input.addEventListener('input', () => {
      const q = input.value.toLowerCase().trim();
      if (!q) {
        filtered = [...items];
      } else {
        filtered = items.filter(it => it.label.toLowerCase().includes(q));
      }
      highlightIdx = -1;
      renderItems();
      dropdown.classList.remove('hidden');
    });

    input.addEventListener('keydown', (e) => {
      if (dropdown.classList.contains('hidden')) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        highlightIdx = Math.min(highlightIdx + 1, filtered.length - 1);
        renderHighlight();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        highlightIdx = Math.max(highlightIdx - 1, 0);
        renderHighlight();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (highlightIdx >= 0 && filtered[highlightIdx]) {
          selectItem(filtered[highlightIdx]);
        }
      } else if (e.key === 'Escape') {
        dropdown.classList.add('hidden');
        input.blur();
      }
    });

    input.addEventListener('blur', () => {
      setTimeout(() => dropdown.classList.add('hidden'), 150);
    });

    function renderItems() {
      dropdown.innerHTML = '';
      filtered.forEach((item, idx) => {
        const div = document.createElement('div');
        div.className = 'dropdown-item';
        div.textContent = item.label;
        div.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectItem(item);
        });
        dropdown.appendChild(div);
      });
    }

    function renderHighlight() {
      const divs = dropdown.querySelectorAll('.dropdown-item');
      divs.forEach((d, i) => {
        d.classList.toggle('highlighted', i === highlightIdx);
      });
      if (highlightIdx >= 0 && divs[highlightIdx]) {
        divs[highlightIdx].scrollIntoView({ block: 'nearest' });
      }
    }

    function selectItem(item) {
      const result = onSelect(item);
      if (result && result.catch) {
        result.catch(err => console.error('Dropdown handler error:', err));
      }
    }
  }

  async function autoSelectChapter1() {
    await loadChapters();
    selectedChapter = 1;
    $('chapter-search').value = '1';
    await autoSelectVerse1();
  }

  async function autoSelectVerse1() {
    await loadVerses();
    selectedVerse = 1;
    $('verse-search').value = '1';
    previewVerse();
  }

  function loadChapters() {
    return new Promise((resolve) => {
      if (!selectedBook) { resolve(); return; }
      $('chapter-search').disabled = false;
      $('verse-search').disabled = true;
      $('verse-search').value = '';
      selectedChapter = null;
      selectedVerse = null;
      $('verse-preview').textContent = 'Select chapter and verse...';
      $('verse-preview').classList.remove('loaded');
      $('start-btn').disabled = true;

      chapterCount = selectedBook.chapters || 50;
      resolve();
    });
  }

  async function loadVerses() {
    if (!selectedBook || !selectedChapter) return;
    $('verse-search').disabled = false;
    selectedVerse = null;
    $('verse-preview').textContent = 'Select a verse...';
    $('verse-preview').classList.remove('loaded');
    $('start-btn').disabled = true;

    await loadVerseCount();
  }

  async function loadVerseCount() {
    if (!selectedBook || !selectedChapter) return;
    verseCount = 40;
    try {
      const fullChapterRes = await fetch(
        `https://api.midvash.com/v1/${selectedTranslation}/${selectedBook.slug.en}/${selectedChapter}`
      );
      const fullChapter = await fullChapterRes.json();
      if (fullChapter.data && fullChapter.data.verses) {
        verseCount = fullChapter.data.verses.length;
      }
    } catch (e) {
      verseCount = 40;
    }
  }

  async function previewVerse() {
    if (!selectedBook || !selectedChapter || !selectedVerse) return;
    const preview = $('verse-preview');
    preview.textContent = 'Loading...';
    preview.classList.remove('loaded');

    try {
      const data = await BibleAPI.getVerse(
        selectedTranslation, selectedBook.slug.en, selectedChapter, selectedVerse
      );
      preview.textContent = `"${data.text}" — ${data.bookName} ${selectedChapter}:${selectedVerse}`;
      preview.classList.add('loaded');
      $('start-btn').disabled = false;
    } catch (e) {
      preview.textContent = 'Error loading verse. Try again.';
      preview.classList.remove('loaded');
    }
  }

  function bindSpreadSlider() {
    const slider = $('spread-slider');
    const label = $('spread-value');
    slider.addEventListener('input', () => {
      spread = parseFloat(slider.value);
      label.textContent = spread + 'x';
    });
  }

  function bindStartButton() {
    $('start-btn').addEventListener('click', () => {
      if (!selectedBook || !selectedChapter || !selectedVerse) return;
      const verseRef = {
        version: selectedTranslation,
        book: selectedBook.slug.en,
        bookName: selectedBook.name.en,
        chapter: selectedChapter,
        verse: selectedVerse,
        spread: spread
      };
      App.startGame(verseRef);
    });
  }

  function reset() {
    selectedBook = null;
    selectedChapter = null;
    selectedVerse = null;
    $('book-search').value = '';
    $('chapter-search').value = '';
    $('chapter-search').disabled = true;
    $('verse-search').value = '';
    $('verse-search').disabled = true;
    $('verse-preview').textContent = '';
    $('verse-preview').classList.remove('loaded');
    $('start-btn').disabled = true;
  }

  async function selectVerse(ref) {
    const book = allBooks.find(b => b.slug.en === ref.book);
    if (!book) return;
    selectedBook = book;
    $('book-search').value = `${book.name.en} (${book.testament === 'old' ? 'OT' : 'NT'})`;
    await loadChapters();
    selectedChapter = ref.chapter;
    $('chapter-search').value = String(ref.chapter);
    await loadVerses();
    selectedVerse = ref.verse;
    $('verse-search').value = String(ref.verse);
    previewVerse();
  }

  return { init, reset, selectVerse };
})();
