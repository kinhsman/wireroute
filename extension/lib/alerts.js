// alerts.js: what to tell you when a server you use dies or comes back.

/**
 * The member a group would use now, leaving out one server: the first that's
 * up, or for a fastest group the quickest that's up.
 */
export function nextMember(group, tunnels, without) {
  const up = group.members.filter((id) => id !== without && tunnels[id]?.state === "up");
  if (!group.fastest || up.length < 2) return up[0] ?? "";
  const speed = (id) => tunnels[id]?.pingMs || Infinity;
  return up.reduce((a, b) => (speed(b) < speed(a) ? b : a));
}

/**
 * The alert for one server's state change, or null for none.
 * @param prev    the server's state before ("up", "down", ...)
 * @param next    its new state
 * @param ctx     {server, groups (in-use groups it's in), tunnels, names: id -> name, killSwitch}
 * @returns {{title, message}} | null
 */
export function alertFor(prev, next, ctx) {
  const { server, groups = [], tunnels = {}, names = {}, killSwitch = true } = ctx;
  if (prev === "up" && next === "down") {
    const g = groups[0];
    if (g) {
      const other = nextMember(g, tunnels, server.id);
      if (other) {
        return {
          title: `${g.name}: switched to ${names[other] ?? "another server"}`,
          message: `${server.name} stopped answering. Sites on ${g.name} now go through ${names[other] ?? "another server"}.`,
        };
      }
      return {
        title: `${g.name}: every server is down`,
        message: `${server.name} stopped answering and no other server in ${g.name} is up. ${killSwitch ? "Its sites are blocked until one comes back." : "Its sites use your normal connection until one comes back."}`,
      };
    }
    return {
      title: `${server.name} is down`,
      message: `It stopped answering. ${killSwitch ? "Sites using it are blocked until it's back." : "Sites using it go out your normal connection until it's back."}`,
    };
  }
  if (prev === "down" && next === "up") {
    return { title: `${server.name} is back`, message: "It's answering again. Sites using it work as before." };
  }
  return null;
}
