import { CalendarClock, MonitorSmartphone } from "lucide-react";

/** The Atividade tab: what the bot has coming (routines) and its computer. Both wait for their phases. */
export function ActivityTab() {
  return (
    <div className="activity">
      <section aria-label="Em breve" data-testid="section-soon">
        <h3 className="panel__section-title">Em breve</h3>
        <div className="panel__box">
          <div className="panel__row">
            <span className="panel__row-icon" aria-hidden="true">
              <CalendarClock size={16} />
            </span>
            <span className="panel__row-text">
              <span className="panel__row-title">Nenhuma rotina</span>
              <span className="panel__row-sub">As rotinas deste bot vão aparecer aqui.</span>
            </span>
          </div>
        </div>
      </section>
      <section aria-label="Computador" data-testid="section-computer">
        <h3 className="panel__section-title">Computador</h3>
        <div className="panel__box">
          <div className="panel__row">
            <span className="panel__row-text">
              <span className="panel__row-title">Computador do bot</span>
              <span className="panel__row-sub">Ainda não disponível</span>
            </span>
            <span className="panel__thumb" aria-hidden="true">
              <MonitorSmartphone size={22} />
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
