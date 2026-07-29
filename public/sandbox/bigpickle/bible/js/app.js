const App = (() => {
  const $ = (id) => document.getElementById(id);

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    $(id).classList.remove('hidden');
  }

  function showSetup(nextVerseRef) {
    showScreen('setup-screen');
    Setup.reset();
    if (nextVerseRef) {
      Setup.selectVerse(nextVerseRef);
    }
  }

  async function startGame(verseRef) {
    showScreen('game-screen');
    try {
      const data = await BibleAPI.getVerse(
        verseRef.version,
        verseRef.book,
        verseRef.chapter,
        verseRef.verse
      );
      const verseData = { ...data, spread: verseRef.spread, showHints: verseRef.showHints, anyOrder: verseRef.anyOrder, autoDuration: verseRef.autoDuration || 500, autoOverlap: verseRef.autoOverlap || 150, bookSlug: verseRef.book };
      Game.init(verseData);
    } catch (e) {
      console.error('Failed to load verse for game:', e);
      showSetup();
    }
  }

  async function startNextVerse(ref) {
    try {
      let { version, book, chapter, verse, spread, showHints, anyOrder, autoDuration, autoOverlap } = ref;
      let nextVerse = verse + 1;
      let nextChapter = chapter;
      let nextBook = book;

      let chapterVerseCount = 40;
      try {
        const fullRes = await fetch(`https://api.midvash.com/v1/${version}/${book}/${chapter}`);
        const fullJson = await fullRes.json();
        if (fullJson.data && fullJson.data.verses) {
          chapterVerseCount = fullJson.data.verses.length;
        }
      } catch (e) {}

      let chapterCount = 50;
      try {
        const bookInfo = await BibleAPI.getBookInfo(book);
        if (bookInfo && bookInfo.chapters) {
          chapterCount = bookInfo.chapters;
        }
      } catch (e) {}

      if (nextVerse > chapterVerseCount) {
        nextVerse = 1;
        nextChapter++;
        if (nextChapter > chapterCount) {
          const books = await BibleAPI.getBooks();
          books.sort((a, b) => a.id - b.id);
          const idx = books.findIndex(b => b.slug.en === book);
          if (idx >= 0 && idx < books.length - 1) {
            nextBook = books[idx + 1].slug.en;
            nextChapter = 1;
          } else {
            showSetup(ref);
            return;
          }
        }
      }

      await startGame({ version, book: nextBook, chapter: nextChapter, verse: nextVerse, spread, showHints, anyOrder, autoDuration, autoOverlap });
    } catch (e) {
      console.error('Failed to navigate to next verse:', e);
      showSetup(ref);
    }
  }

  function init() {
    Setup.init();
    showScreen('setup-screen');
  }

  document.addEventListener('DOMContentLoaded', init);

  return { showSetup, startGame, startNextVerse };
})();
