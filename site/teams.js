/* Team colors for the league's 30 teams (named for NBA cities): [primary, secondary].
 * Used as CSS variables --c1 / --c2 on team chips, banners and cards. */
var TEAM_COLORS = {
  ATL: ["#C8102E", "#FDB927"], BOS: ["#007A33", "#BA9653"], BKN: ["#111111", "#9EA2A2"], CHA: ["#1D1160", "#00788C"],
  CHI: ["#CE1141", "#111111"], CLE: ["#860038", "#FDBB30"], DAL: ["#00538C", "#B8C4CA"], DEN: ["#0E2240", "#FEC524"],
  DET: ["#C8102E", "#1D42BA"], GSW: ["#1D428A", "#FFC72C"], HOU: ["#CE1141", "#C4CED4"], IND: ["#002D62", "#FDBB30"],
  LAC: ["#C8102E", "#1D428A"], LAL: ["#552583", "#FDB927"], MEM: ["#5D76A9", "#12173F"], MIA: ["#98002E", "#F9A01B"],
  MIL: ["#00471B", "#EEE1C6"], MIN: ["#0C2340", "#78BE20"], NOP: ["#0C2340", "#C8102E"], NYK: ["#006BB6", "#F58426"],
  OKC: ["#007AC1", "#EF3B24"], ORL: ["#0077C0", "#C4CED4"], PHI: ["#006BB6", "#ED174C"], PHX: ["#1D1160", "#E56020"],
  POR: ["#E03A3E", "#111111"], SAC: ["#5A2D81", "#9CA3AA"], SAS: ["#111111", "#C4CED4"], TOR: ["#CE1141", "#111111"],
  UTA: ["#002B5C", "#F9A01B"], WAS: ["#002B5C", "#E31837"],
};
// style="--c1:…;--c2:…" for a team code (empty when unknown)
function teamStyle(code) {
  var c = TEAM_COLORS[code];
  return c ? ' style="--c1:' + c[0] + ";--c2:" + c[1] + '"' : "";
}
