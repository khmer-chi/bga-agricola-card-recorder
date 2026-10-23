// Shared checks for the "my point of view" labels.
// k(pid): 1 for the player I pass to, 2 for the next one, ...
const kOf = (s, pid) => {
  const order = s.playerOrder, n = order.length;
  const d = ((order.indexOf(pid) - order.indexOf(s.myId)) * s.direction) % n;
  return (d + n) % n;
};
// Played-card tag vs the round the card was actually drafted in.
const playedOk = (s, label, by, truth, seen) => {
  if (label === '首選') return truth === 1;
  let m;
  if ((m = label.match(/^我第(\d+)輪傳出$/))) return truth === Number(m[1]) + kOf(s, by);
  if ((m = label.match(/^我第(\d+)輪選$/))) return by === s.myId && truth === Number(m[1]);
  if (label === '我沒看過') return !seen && truth >= 1 && truth <= kOf(s, by);
  return false;
};
module.exports = { kOf, playedOk };
