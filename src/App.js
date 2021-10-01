import { Layout, Menu, Avatar } from 'antd';
import {
  AreaChartOutlined,
  DiffOutlined,
  AuditOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { createUseStyles } from 'react-jss';
import './App.css';
import {
  HashRouter as Router,
  Switch,
  Route,
  Link,
  useLocation,
} from 'react-router-dom';
import { Dashboard, Tracking, TaxReports, Settings } from './pages';
import { useTranslation } from 'react-i18next';
import { useState, useContext, useEffect } from 'react';
import { SettingsContext, defaultSettings } from './SettingsContext';
import axios from 'axios';
import GeoPattern from 'geopattern';

const { Content, Footer, Sider } = Layout;

const useStyles = createUseStyles({
  account: {
    color: 'white',
    display: 'flex',
    alignItems: 'center',
    padding: '12px 12px 0 12px',
    fontWeight: 600,
  },
  accountName: {
    marginLeft: 6,
  },
  accountRow: {
    paddingTop: 12,
    paddingBottom: 12,
    width: 176,
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
  const [settings, updateSettings] = useContext(SettingsContext);
  const { backendUrl, account } = settings;

  useEffect(() => {
    axios.get(`${backendUrl}/accounts`).then((response) => {
      let activeAccount = localStorage.getItem('activeAccount');
      let selectedAccount = response.data[0];

      if (typeof activeAccount !== 'undefined') {
        selectedAccount =
          response.data.find((account) => account.name === activeAccount) ||
          selectedAccount;
      }

      updateSettings((prevSettings) => ({
        ...prevSettings,
        account: selectedAccount,
      }));
    });
  }, [backendUrl, updateSettings]);

  return (
    <Layout>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={(isCollapsed) => setCollapsed(isCollapsed)}
      >
        <div className={classes.account}>
          <Avatar
            style={{
              backgroundImage: GeoPattern.generate(account.pattern).toDataUrl(),
              backgroundSize: 'cover',
            }}
          />
          <span className={classes.accountName}>{account.name}</span>
        </div>
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
  const [settings, updateSettings] = useState(defaultSettings);

  return (
    <SettingsContext.Provider value={[settings, updateSettings]}>
      <Router>
        <Main />
      </Router>
    </SettingsContext.Provider>
  );
};

export default App;
