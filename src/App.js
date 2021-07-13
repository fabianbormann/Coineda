import { Layout, Menu } from 'antd';
import {
  AreaChartOutlined,
  DiffOutlined,
  AuditOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { createUseStyles } from 'react-jss';
import './App.css';
import {
  BrowserRouter as Router,
  Switch,
  Route,
  Link,
  useLocation,
} from 'react-router-dom';
import { Dashboard, Tracking, TaxReports, Settings } from './pages';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';

const { Content, Footer, Sider } = Layout;

const useStyles = createUseStyles({
  logo: {
    color: 'white',
    display: 'flex',
    alignItems: 'center',
    marginLeft: 24,
    fontWeight: 600,
    height: 40,
  },
  content: {
    minHeight: '100vh',
    width: '80%',
    margin: '0 auto',
    display: 'flex',
    justifyContent: 'center',
    marginTop: 2,
  },
});

const Main = () => {
  const classes = useStyles();
  const location = useLocation();
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <Layout>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={(isCollapsed) => setCollapsed(isCollapsed)}
      >
        <div className={classes.logo}>Coineda</div>
        <Menu
          theme="dark"
          mode="inline"
          defaultSelectedKeys={['/']}
          selectedKeys={[location.pathname]}
        >
          <Menu.Item key="/" icon={<AreaChartOutlined />}>
            <Link to="/">{t('Dashboard')}</Link>
          </Menu.Item>
          <Menu.Item key="/tracking" icon={<DiffOutlined />}>
            <Link to="/tracking">{t('Tracking')}</Link>
          </Menu.Item>
          <Menu.Item key="/reports" icon={<AuditOutlined />}>
            <Link to="/reports">{t('Tax Reports')}</Link>
          </Menu.Item>
          <Menu.Item key="/settings" icon={<ToolOutlined />}>
            <Link to="/settings">{t('Settings')}</Link>
          </Menu.Item>
        </Menu>
      </Sider>
      <Layout>
        <Content>
          <div className={classes.content}>
            <Switch>
              <Route exact path="/">
                <Dashboard />
              </Route>
              <Route path="/tracking">
                <Tracking />
              </Route>
              <Route path="/reports">
                <TaxReports />
              </Route>
              <Route path="/settings">
                <Settings />
              </Route>
            </Switch>
          </div>
        </Content>
        <Footer style={{ textAlign: 'center' }}>
          Coineda ©2021 Created by Fabian Bormann
        </Footer>
      </Layout>
    </Layout>
  );
};

const App = () => {
  return (
    <Router>
      <Main />
    </Router>
  );
};

export default App;
