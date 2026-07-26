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
      data.spread = verseRef.spread;
      data.bookSlug = verseRef.book;
      Game.init(data);
    } catch (e) {
      console.error('Failed to load verse for game:', e);
      showSetup();
    }
  }

  function init() {
    Setup.init();
    showScreen('setup-screen');
  }

  document.addEventListener('DOMContentLoaded', init);

  return { showSetup, startGame };
})();
