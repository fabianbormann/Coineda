import React from 'react';
import { Layout, Menu, Avatar } from 'antd';
import {
  AreaChartOutlined,
  DiffOutlined,
  AuditOutlined,
  ToolOutlined,
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
import { Dashboard, Tracking, TaxReports, Settings, Wallets } from './pages';
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
    padding: '12px 12px 6px 12px',
    fontWeight: 600,
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
});

const Main = () => {
  const classes = useStyles();
  const location = useLocation();
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [collapsing, setCollapsing] = useState(false);
  const [settings, updateSettings] = useContext(SettingsContext);
  const { backendUrl, account } = settings;

  useEffect(() => {
    axios.get(`${backendUrl}/accounts`).then((response) => {
      let activeAccount = document.localStorage.getItem('activeAccount');
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
          <Avatar
            style={{
              backgroundImage: GeoPattern.generate(account.pattern).toDataUrl(),
              backgroundSize: 'cover',
            }}
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
        </Menu>
      </Sider>
      <Layout>
        <Content>
          <div
            className={classes.content}
            style={{ marginLeft: collapsed ? 80 : 200 }}
          >
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/tracking/*" element={<Tracking />} />
              <Route path="/reports/*" element={<TaxReports />} />
              <Route path="/wallets/*" element={<Wallets />} />
              <Route path="/settings/*" element={<Settings />} />
            </Routes>
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
      <Router>{/*<Main />*/}</Router>
    </SettingsContext.Provider>
  );
};

export default App;
