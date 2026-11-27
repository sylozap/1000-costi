export const session = {
  me: null,
  isAdmin: false,
  state: null,
  clockOffset: 0,
};

export function canEditRules(s) {
  return (session.me === s.owner && s.status === 'lobby') || session.isAdmin;
}
