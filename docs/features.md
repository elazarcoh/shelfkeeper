# Features in detail

[← Back to the README](../README.md)

## Sources

Admin → Sources → **Add source** connects an Audiobookshelf server (URL + an API token from Audiobookshelf → Settings → Users → your user). Shelfkeeper only ever *reads* from it. **Sync now** (or a schedule) brings its books into the **Inbox**, where you decide for each one: add it as an edition of a book you have, link it to an existing copy, create a new book, or ignore it. Books that later disappear from Audiobookshelf are marked "no longer have it" (never deleted), and come back if the file does. When two sources read the same files (Audiobookshelf and Chaptarr on one folder, mounted at different paths), a book's folder within its library root ties them together: the second source's copy of the same format links to the first one's copy by itself, without an Inbox step. Every sync is listed under Admin → Jobs, with a Re-run button.

## Reading progress

Optional. In the daily check-in, type where you are (a page, a time, or a percentage for an ebook) and the button becomes "Still going · page …"; leave it empty and nothing changes. On a book's page, **Update progress** adds or corrects an update for any day of the read. Progress fills Home's bar under the cover, and the stats count the reading on the days it happened rather than all at the finish.

## Adding books from a shelf

Add → **From a shelf photo**. Photograph a shelf or a stack, tap **Copy prompt**, and paste it with the photo into your own AI app (Claude, Gemini…). Paste its answer back and tap **Read the list**: each book shows whether it is new, a physical copy of a book you have in another format, already on your shelves, already in your Inbox, or a repeat — those last three start unchecked. Choose Owned or Borrowed and **Add** — the books wait in your Inbox.

To fill in the details and cover, link each book to its page. Hebrew books are looked up on Simania: **Find on Simania** opens its search; on the book's page tap Share → Copy link and paste it into the card (or, once set up, tap the optional **mylib** bookmarklet instead). English books are looked up on Open Library, right in the app: **Search Open Library** and pick the right one. Each card can switch between the two. **Add one book** works the same way and adds the book straight to your library after one review. Shelfkeeper never searches or crawls Simania itself — it reads only the one page you link; Open Library is searched through its public API, once per tap.

**Scan barcode** (next to every look-up) reads the ISBN barcode on a book's back cover with the phone's camera, or from a photo, or typed. The picture is read on the phone; only the number is sent. The ISBN is looked up on Open Library and at the National Library of Israel (an Israeli ISBN, 978-965, asks the National Library first), and the book opens for review — after **Add**, the scanner opens again for the next book. Not found on either: the ISBN waits on the Simania tab. The National Library's search API needs a free personal key ([sign up](https://api2.nli.org.il/signup/)): set it as `NLI_API_KEY` on the server; without one, ISBNs are looked up on Open Library only. Each scan makes at most three requests (one to Open Library, two to the National Library).

## Wishlist

Each person keeps a list of books they want, and everyone in the household can read it (handy for gift ideas). To add a book, send its Simania or Open Library page the same way as **Add one book** and choose **Wishlist**, or press **Want it** on a book's page. A wish can name formats (any if none), a language and a note. A book you wish for that nobody owns yet lives only on the Wishlist page; in the Library, Availability → Wanted shows it. Books on someone's list carry a gift mark in the Library. **Bought** adds your copy, pre-filled from the page you shared, and removes the wish.

## Not yet

Stats filters by tag, author or format, and week-by-week granularity (stats are by year and month).
