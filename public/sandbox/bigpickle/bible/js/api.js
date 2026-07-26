const BibleAPI = (() => {
  const BASE = 'https://api.midvash.com/v1';

  async function getBooks(testament) {
    const url = testament
      ? `${BASE}/books?testament=${testament}`
      : `${BASE}/books`;
    const res = await fetch(url);
    const json = await res.json();
    return json.data;
  }

  async function getBookInfo(slug) {
    const res = await fetch(`${BASE}/books/${slug}`);
    const json = await res.json();
    return json.data;
  }

  async function getVerse(version, book, chapter, verse) {
    const res = await fetch(`${BASE}/${version}/${book}/${chapter}/${verse}`);
    const json = await res.json();
    return json.data;
  }

  return { getBooks, getBookInfo, getVerse };
})();
