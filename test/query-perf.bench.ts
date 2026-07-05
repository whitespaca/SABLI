import { bench, describe } from "vitest";
import { parseQuery } from "../src/index.js";
import { QueryInputGuard } from "../src/validation/schemas.js";

const complexQuery = {
  where: {
    and: [
      { path: "user.age", gt: 20 },
      { path: "user.tags", contains: "developer" },
      {
        or: [
          { path: "user.name", eq: "Alice" },
          {
            elemMatch: {
              path: "user.history",
              where: { path: "status", eq: "active" }
            }
          }
        ]
      }
    ]
  }
};

describe("Query Validation Performance Breakdown", () => {
  bench("Full parseQuery", () => {
    parseQuery(complexQuery);
  });
  bench("QueryInputGuard.check Only", () => {
    QueryInputGuard.check(complexQuery);
  });
});
