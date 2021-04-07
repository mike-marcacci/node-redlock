import Redlock from "../src/redlock";

it("should throw an error if not passed any clients", function () {
  expect(
    () =>
      new Redlock([], {
        retryCount: 2,
        retryDelay: 150,
        retryJitter: 0,
      })
  ).toThrow(/with at least one/);
});
