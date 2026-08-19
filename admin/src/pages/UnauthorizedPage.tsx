import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';

export function UnauthorizedPage() {
  return (
    <section className="content-page centered-content">
      <div className="message-card compact">
        <span className="message-icon"><Icon name="shield" /></span>
        <span className="message-code">POLICY / 403</span>
        <h1>当前角色无权访问</h1>
        <p>该模块未包含在你的有效权限快照中。如工作职责发生变化，请联系访问管理员调整企业身份组。</p>
        <Link className="button button-secondary" to="/">返回可用工作区</Link>
      </div>
    </section>
  );
}
