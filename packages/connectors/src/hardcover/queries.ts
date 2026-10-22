/** One top-level field per operation: each costs one request against Hardcover's limits. */
export const ME = 'query Me { me { id username } }'
export const EDITIONS_BY_ISBN = 'query EditionsByIsbn($isbns: [String!]) { editions(where: {_or: [{isbn_13: {_in: $isbns}}, {isbn_10: {_in: $isbns}}]}, limit: 500) { id isbn_13 isbn_10 book_id } }'
const BOOK_FIELDS = 'id slug title rating ratings_count cached_tags cached_similar_book_ids'
export const BOOKS_BY_ID = `query BooksById($ids: [Int!]) { books(where: {id: {_in: $ids}}) { ${BOOK_FIELDS} } }`
const PAGE_FIELDS =
  'id slug title description release_date cached_image cached_contributors book_series { position featured series { id name } } default_physical_edition_id default_cover_edition_id editions(order_by: {id: asc}, limit: 100) { id title isbn_13 isbn_10 pages release_date edition_format reading_format_id publisher { name } cached_image language { code3 } }'
export const BOOK_PAGE_BY_ID = `query BookPageById($id: Int!) { books(where: {id: {_eq: $id}}, limit: 1) { ${PAGE_FIELDS} } }`
export const BOOK_PAGE_BY_SLUG = `query BookPageBySlug($slug: String!) { books(where: {slug: {_eq: $slug}}, limit: 1) { ${PAGE_FIELDS} } }`
export const SEARCH_BOOKS = 'query SearchBooks($q: String!) { search(query: $q, query_type: "Book", per_page: 8, page: 1) { results } }'
export const RECOMMENDATIONS = 'query Recommendations($userId: Int!) { vibes(where: {user_id: {_eq: $userId}, vibe_type: {_eq: 1}}, limit: 1) { cached_book_ids } }'
export const USER_BOOK = 'query UserBook($userId: Int!, $bookId: Int!) { user_books(where: {user_id: {_eq: $userId}, book_id: {_eq: $bookId}}, limit: 1) { id status_id rating } }'
export const INSERT_USER_BOOK = 'mutation InsertUserBook($object: UserBookCreateInput!) { insert_user_book(object: $object) { id error } }'
export const UPDATE_USER_BOOK = 'mutation UpdateUserBook($id: Int!, $object: UserBookUpdateInput!) { update_user_book(id: $id, object: $object) { id error } }'
export const INSERT_READ = 'mutation InsertRead($id: Int!, $read: DatesReadInput!) { insert_user_book_read(user_book_id: $id, user_book_read: $read) { id error } }'
export const BOOK_DETAILS = 'query BookDetails($ids: [Int!]) { books(where: {id: {_in: $ids}}) { id title pages release_date cached_image cached_contributors cached_tags book_series { position featured series { id name } } editions(where: {reading_format_id: {_eq: 2}}, limit: 1) { id } } }'
export const SERIES_BOOKS = 'query SeriesBooks($ids: [Int!]) { book_series(where: {series_id: {_in: $ids}, book: {compilation: {_eq: false}, canonical_id: {_is_null: true}}}, order_by: {position: asc}) { series_id position series { name } book { id title release_date users_count } } }'
export const AUTHOR_BOOKS = 'query AuthorBooks($ids: [Int!], $since: date!, $until: date!) { contributions(where: {author_id: {_in: $ids}, contributable_type: {_eq: "Book"}, _or: [{contribution: {_is_null: true}}, {contribution: {_eq: "Author"}}], book: {compilation: {_eq: false}, canonical_id: {_is_null: true}, release_date: {_gte: $since, _lte: $until}}}, order_by: {book: {users_count: desc}}, limit: 200) { author_id book { id title release_date } } }'
export const READ_BOOK_IDS = 'query ReadBookIds($userId: Int!, $offset: Int!) { user_books(where: {user_id: {_eq: $userId}, status_id: {_eq: 3}}, order_by: {id: asc}, limit: 500, offset: $offset) { book_id } }'
