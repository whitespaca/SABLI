import { createPostingList, type PostingList } from "../indexes/posting.js";
import type { DocId } from "../types/json.js";

/**
 * Candidate document set used by query planning.
 */
export class CandidateSet {
  readonly #postings: PostingList;

  /**
   * Creates a candidate set from document identifiers.
   *
   * @param docIds - Candidate document identifiers.
   */
  public constructor(docIds: readonly DocId[]) {
    this.#postings = createPostingList(docIds);
  }

  /**
   * Converts this candidate set into a posting list.
   *
   * @returns Posting list representation.
   */
  public toPostingList(): PostingList {
    return this.#postings;
  }
}
