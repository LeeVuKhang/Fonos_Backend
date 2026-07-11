export class CommunityService {
  constructor({ repository }) {
    this.repository = repository;
  }

  listReviews(bookId, uid, page) {
    return this.repository.listReviews(bookId, uid, page);
  }

  upsertReview(bookId, uid, input) {
    return this.repository.upsertReview(bookId, uid, input);
  }

  deleteReview(bookId, uid) {
    return this.repository.deleteReview(bookId, uid);
  }

  saveBook(bookId, uid) {
    return this.repository.setSaved(bookId, uid, true);
  }

  unsaveBook(bookId, uid) {
    return this.repository.setSaved(bookId, uid, false);
  }
}
