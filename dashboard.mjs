export function createDashboard(db) {
  const one = (sql, ...args) => db.prepare(sql).get(...args),
    all = (sql, ...args) => db.prepare(sql).all(...args);

  function stats() {
    const totalClients = one('SELECT COUNT(*) AS n FROM clients').n;
    const totalVehicles = one('SELECT COUNT(*) AS n FROM vehicles').n;
    const totalDeals = one('SELECT COUNT(*) AS n FROM deals').n;
    const activeDeals = one("SELECT COUNT(*) AS n FROM deals WHERE stage IN ('new','contacted','negotiation','proposal')").n;
    const wonDeals = one("SELECT COUNT(*) AS n FROM deals WHERE stage='won'").n;
    const lostDeals = one("SELECT COUNT(*) AS n FROM deals WHERE stage='lost'").n;
    const totalRevenue = one("SELECT COALESCE(SUM(amount),0) AS n FROM deals WHERE stage='won'").n;
    const pipelineValue = one("SELECT COALESCE(SUM(amount),0) AS n FROM deals WHERE stage IN ('new','contacted','negotiation','proposal')").n;

    const appointmentsByStatus = all(
      'SELECT status, COUNT(*) AS count FROM appointments GROUP BY status',
    );
    const totalAppointments = one('SELECT COUNT(*) AS n FROM appointments').n;
    const activeAppointments = one(
      "SELECT COUNT(*) AS n FROM appointments WHERE status IN ('new','confirmed','in_progress')",
    ).n;

    const dealsByStage = all(
      'SELECT stage, COUNT(*) AS count, COALESCE(SUM(amount),0) AS total FROM deals GROUP BY stage',
    );

    const dealsByMonth = all(
      "SELECT strftime('%Y-%m', created_at/1000, 'unixepoch') AS month, COUNT(*) AS count, COALESCE(SUM(amount),0) AS total FROM deals GROUP BY month ORDER BY month DESC LIMIT 12",
    );

    const recentDeals = all(
      'SELECT d.id, d.title, d.stage, d.amount, d.updated_at, c.name AS client_name FROM deals d LEFT JOIN clients c ON c.id=d.client_id ORDER BY d.updated_at DESC LIMIT 10',
    );

    const vehiclesByBrand = all(
      'SELECT brand, COUNT(*) AS count FROM vehicles GROUP BY brand ORDER BY count DESC',
    );

    const clientsThisMonth = one(
      "SELECT COUNT(*) AS n FROM clients WHERE created_at > ? ",
      Date.now() - 30 * 86400000,
    ).n;

    const dealsThisMonth = one(
      "SELECT COUNT(*) AS n FROM deals WHERE created_at > ?",
      Date.now() - 30 * 86400000,
    ).n;

    const wonRate = wonDeals + lostDeals > 0
      ? Math.round((wonDeals / (wonDeals + lostDeals)) * 100)
      : 0;

    const managerStats = all(
      "SELECT m.name, COUNT(d.id) AS deals_count, COALESCE(SUM(CASE WHEN d.stage='won' THEN d.amount ELSE 0 END),0) AS won_total FROM managers m LEFT JOIN deals d ON d.manager_id=m.id GROUP BY m.id ORDER BY won_total DESC",
    );

    return {
      overview: {
        totalClients,
        totalVehicles,
        totalDeals,
        activeDeals,
        wonDeals,
        lostDeals,
        totalRevenue,
        pipelineValue,
        totalAppointments,
        activeAppointments,
        clientsThisMonth,
        dealsThisMonth,
        wonRate,
      },
      dealsByStage,
      dealsByMonth: dealsByMonth.reverse(),
      appointmentsByStatus,
      recentDeals,
      vehiclesByBrand,
      managerStats,
    };
  }

  return { stats };
}
