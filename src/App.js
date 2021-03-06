import { Layout, Menu } from 'antd';
import {
  AreaChartOutlined,
  DiffOutlined,
  AuditOutlined,
  ToolOutlined,
  ExclamationCircleOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { createUseStyles } from 'react-jss';
import './App.css';
import {
  HashRouter as Router,
  Routes,
  Route,
  Link,
  useLocation,
} from 'react-router-dom';
import {
  Dashboard,
  Tracking,
  TaxReports,
  Settings,
  Wallets,
  Issues,
} from './pages';
import { useTranslation } from 'react-i18next';
import { useState, useContext, useEffect } from 'react';
import { SettingsContext, defaultSettings } from './SettingsContext';
import storage from './persistence/storage';
import Blockies from 'react-blockies';

const { Content, Footer, Sider } = Layout;

const useStyles = createUseStyles({
  account: {
    color: 'white',
    display: 'flex',
    alignItems: 'center',
    padding: '12px 12px 6px 12px',
    fontWeight: 600,
  },
  blockie: {
    borderRadius: '50%',
  },
  accountRow: {
    paddingTop: 12,
    paddingBottom: 12,
    width: 176,
  },
  sider: {
    height: '100vh',
    position: 'fixed',
    left: 0,
    zIndex: 2,
  },
  content: {
    overflow: 'auto',
    minHeight: '100vh',
    display: 'flex',
    justifyContent: 'center',
    transition: 'margin-left 250ms ease-in-out',
  },
  footer: {
    textAlign: 'center',
  },
});

const Main = () => {
  const classes = useStyles();
  const location = useLocation();
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [collapsing, setCollapsing] = useState(false);
  const [settings, updateSettings] = useContext(SettingsContext);
  const { account } = settings;

  useEffect(() => {
    storage.accounts.getAll().then((accounts) => {
      if (accounts.length === 0) {
        accounts = [
          {
            id: 1,
            name: 'Coineda',
            pattern: 'DEFAULT7',
          },
        ];

        storage.accounts.add(accounts[0].name, accounts[0].pattern);
      }

      let activeAccount = localStorage.getItem('activeAccount');
      let selectedAccount = accounts[0];

      if (typeof activeAccount !== 'undefined') {
        selectedAccount =
          accounts.find((account) => account.name === activeAccount) ||
          selectedAccount;
      }

      updateSettings((prevSettings) => ({
        ...prevSettings,
        account: selectedAccount,
      }));
    });
  }, [updateSettings]);

  const smallScreen = window.screen.width < 768;

  return (
    <Layout>
      <Sider
        className={classes.sider}
        collapsible
        collapsed={collapsed}
        breakpoint="sm"
        onCollapse={(isCollapsed) => {
          setCollapsing(true);
          setTimeout(() => {
            setCollapsing(false);
          }, 250);
          setCollapsed(isCollapsed);
        }}
      >
        <div
          className={classes.account}
          style={
            collapsed
              ? { justifyContent: 'center', marginLeft: -2 }
              : { justifyContent: 'flex-start', marginLeft: 2 }
          }
        >
          <Blockies
            seed={account.pattern}
            size={8}
            className={classes.blockie}
          />
          <span
            style={
              collapsed || collapsing
                ? {
                    width: 0,
                    opacity: 0,
                    overflow: 'hidden',
                  }
                : {
                    marginLeft: 6,
                    opacity: 1,
                    width: 'auto',
                  }
            }
          >
            {account.name}
          </span>
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
          <Menu.Item key="/wallets" icon={<WalletOutlined />}>
            <Link to="/wallets">{t('Wallets')}</Link>
          </Menu.Item>
          <Menu.Item key="/settings" icon={<ToolOutlined />}>
            <Link to="/settings">{t('Settings')}</Link>
          </Menu.Item>
          <Menu.Item key="/issues" icon={<ExclamationCircleOutlined />}>
            <Link to="/issues">{t('Issues')}</Link>
          </Menu.Item>
        </Menu>
      </Sider>
      <Layout>
        <Content>
          <div
            className={classes.content}
            style={{ marginLeft: collapsed || smallScreen ? 80 : 200 }}
          >
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/tracking/*" element={<Tracking />} />
              <Route path="/reports/*" element={<TaxReports />} />
              <Route path="/wallets/*" element={<Wallets />} />
              <Route path="/settings/*" element={<Settings />} />
              <Route path="/issues/*" element={<Issues />} />
            </Routes>
          </div>
        </Content>
        <Footer
          className={classes.footer}
          style={{ marginLeft: collapsed || smallScreen ? 80 : 200 }}
        >
          Coineda ??2022 made with ?????? by Fabian Bormann
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
