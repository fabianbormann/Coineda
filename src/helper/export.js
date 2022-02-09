import storage from '../persistence/storage';
import packageJSON from '../../package.json';

const exportData = async (account) => {
  const transactions = await storage.transactions.getAllFromAccount(account);
  const transfers = await storage.transfers.getAllFromAccount(account);

  let data =
    '<header>\nformat:coineda\nversion:' +
    packageJSON.version +
    '\n</header>\n';
  data += '<transactions>';

  if (transactions.length > 0) {
    data += '\n';
    data += Object.keys(transactions[0]).join(';');

    for (const transaction of transactions) {
      data += '\n' + Object.values(transaction).join(';');
    }
  }

  data += '\n</transactions>\n<transfers>';

  if (transfers.length > 0) {
    data += '\n';
    data += Object.keys(transfers[0]).join(';');

    for (const transfer of transfers) {
      data += '\n' + Object.values(transfer).join(';');
    }
  }

  data += '\n</transfers>';

  const filename =
    'coineda-export-' + new Date().toISOString().split('T')[0] + '.cnd';

  const element = document.createElement('a');
  element.setAttribute(
    'href',
    'data:text/plain;charset=utf-8,' + encodeURIComponent(data)
  );
  element.setAttribute('download', filename);
  element.style.display = 'none';
  document.body.appendChild(element);
  element.click();
  document.body.removeChild(element);
};

export { exportData };
