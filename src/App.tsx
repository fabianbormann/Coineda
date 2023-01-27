import React, { useState, useContext, useEffect } from 'react';
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
import { SettingsContext, defaultSettings } from './SettingsContext';
import storage from './persistence/storage';
import Jazzicon from 'react-jazzicon';
import MuiDrawer from '@mui/material/Drawer';
import { styled } from '@mui/material/styles';
import Footer from './components/Footer';
import Toolbar from '@mui/material/Toolbar';
import IconButton from '@mui/material/IconButton';
import { ChevronLeft } from '@mui/icons-material';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import AccountBalanceIcon from '@mui/icons-material/AccountBalance';
import AccountBalanceWalletIcon from '@mui/icons-material/AccountBalanceWallet';
import BugReportIcon from '@mui/icons-material/BugReport';
import SettingsIcon from '@mui/icons-material/Settings';
import MenuIcon from '@mui/icons-material/Menu';
import DashboardIcon from '@mui/icons-material/Dashboard';
import MuiAppBar, { AppBarProps as MuiAppBarProps } from '@mui/material/AppBar';
import {
  Box,
  Container,
  Divider,
  Grid,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
} from '@mui/material';
import {
  CoinedaAccount,
  CoinedaSettings,
  NavigationItemProps,
} from './global/types';

const drawerWidth: number = 240;

const Drawer = styled(MuiDrawer, {
  shouldForwardProp: (prop) => prop !== 'open',
})(({ theme, open }) => ({
  '& .MuiDrawer-paper': {
    position: 'relative',
    whiteSpace: 'nowrap',
    width: drawerWidth,
    transition: theme.transitions.create('width', {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.enteringScreen,
    }),
    boxSizing: 'border-box',
    ...(!open && {
      overflowX: 'hidden',
      transition: theme.transitions.create('width', {
        easing: theme.transitions.easing.sharp,
        duration: theme.transitions.duration.leavingScreen,
      }),
      width: theme.spacing(7),
      [theme.breakpoints.up('sm')]: {
        width: theme.spacing(9),
      },
    }),
  },
}));

const Content = styled('main')(({ theme }) => ({
  backgroundColor:
    theme.palette.mode === 'light'
      ? theme.palette.grey[100]
      : theme.palette.grey[900],
  flexGrow: 1,
  height: '100vh',
  overflow: 'auto',
  display: 'flex',
  flexDirection: 'column',
}));

interface AppBarProps extends MuiAppBarProps {
  open?: boolean;
}

const AppBar = styled(MuiAppBar, {
  shouldForwardProp: (prop) => prop !== 'open',
})<AppBarProps>(({ theme, open }) => ({
  zIndex: theme.zIndex.drawer + 1,
  transition: theme.transitions.create(['width', 'margin'], {
    easing: theme.transitions.easing.sharp,
    duration: theme.transitions.duration.leavingScreen,
  }),
  ...(open && {
    marginLeft: drawerWidth,
    width: `calc(100% - ${drawerWidth}px)`,
    transition: theme.transitions.create(['width', 'margin'], {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.enteringScreen,
    }),
  }),
}));

const NavigationItem = (props: NavigationItemProps) => (
  <ListItemButton component={Link} to={props.location}>
    <ListItemIcon>{props.icon}</ListItemIcon>
    <ListItemText primary={props.title} />
  </ListItemButton>
);

const Main = () => {
  const location = useLocation();
  const { t } = useTranslation();
  const [drawerOpen, setDrawerOpen] = useState(true);
  const { settings, setSettings } = useContext(SettingsContext);
  const { account } = settings;

  useEffect(() => {
    storage.accounts.getAll().then((accounts: Array<CoinedaAccount>) => {
      if (accounts.length === 0) {
        accounts = [
          {
            id: 1,
            name: 'Coineda',
            pattern: 0,
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

      setSettings({
        ...settings,
        account: selectedAccount,
      });
    });
  }, [setSettings]);

  const toggleDrawer = () => {
    setDrawerOpen(!drawerOpen);
  };

  return (
    <Box sx={{ display: 'flex' }}>
      <AppBar position="absolute" open={drawerOpen}>
        <Toolbar sx={{ pr: '24px' }}>
          <IconButton
            edge="start"
            color="inherit"
            aria-label="open drawer"
            onClick={toggleDrawer}
            sx={{
              marginRight: '36px',
              ...(drawerOpen && { display: 'none' }),
            }}
          >
            <MenuIcon />
          </IconButton>
          <Typography
            component="h1"
            variant="h6"
            color="inherit"
            noWrap
            sx={{ flexGrow: 1 }}
          >
            Dashboard
          </Typography>
        </Toolbar>
      </AppBar>
      <Drawer variant="permanent" open={drawerOpen}>
        <Toolbar
          sx={{
            display: 'flex',
            alignItems: 'center',
            px: [1],
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: 8,
            }}
          >
            <div style={{ minWidth: 56 }}>
              <Jazzicon seed={settings.account.pattern} diameter={32} />
            </div>
            <div>
              <Typography>{account.name}</Typography>
            </div>
          </div>
          <div style={{ flexGrow: 1 }} />
          <IconButton onClick={toggleDrawer}>
            <ChevronLeft />
          </IconButton>
        </Toolbar>
        <Divider />
        <List component="nav">
          <NavigationItem
            title={t('Dashboard')}
            location="/"
            icon={<DashboardIcon />}
          />
          <NavigationItem
            title={t('Tracking')}
            location="/tracking"
            icon={<NoteAddIcon />}
          />
          <NavigationItem
            title={t('Tax Reports')}
            location="/reports"
            icon={<AccountBalanceIcon />}
          />
          <NavigationItem
            title={t('Wallets')}
            location="/wallets"
            icon={<AccountBalanceWalletIcon />}
          />
          <NavigationItem
            title={t('Settings')}
            location="/settings"
            icon={<SettingsIcon />}
          />
          <NavigationItem
            title={t('Issues')}
            location="/issues"
            icon={<BugReportIcon />}
          />
        </List>
      </Drawer>
      <Content>
        <Toolbar />
        <Container maxWidth="lg" sx={{ mt: 4, mb: 4, flexGrow: 1 }}>
          <Grid container spacing={3}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/tracking/*" element={<Tracking />} />
              <Route path="/reports/*" element={<TaxReports />} />
              <Route path="/wallets/*" element={<Wallets />} />
              <Route path="/settings/*" element={<Settings />} />
              <Route path="/issues/*" element={<Issues />} />
            </Routes>
          </Grid>
        </Container>
        <Footer />
      </Content>
    </Box>
  );
};

const App = () => {
  const [settings, setSettings] = useState<CoinedaSettings>(defaultSettings);

  return (
    <SettingsContext.Provider value={{ settings, setSettings }}>
      <Router>
        <Main />
      </Router>
    </SettingsContext.Provider>
  );
};

export default App;
