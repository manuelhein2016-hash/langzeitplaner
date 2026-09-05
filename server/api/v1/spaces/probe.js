// TEMPORARY diagnostic — deleted in the next commit.
// A plain, non-dynamic function three levels under api/. If this answers and the catch-all does
// not, the problem is dynamic-segment expansion. If this 404s too, deep routing itself is broken
// and the catch-all is innocent.
export const config = { runtime: 'nodejs' };
export default function handler(req, res) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ probe: 'reached', url: req.url }));
}
