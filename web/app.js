import { BrowserProvider, Contract, JsonRpcProvider, formatEther, getAddress, parseEther } from "/ethers.js";

const $ = id => document.getElementById(id);
const states = ["Активна", "Відхилена", "Схвалена", "Виконана"];
const errors = {
  InvalidPayment: "Вкажіть ненульову адресу та суму.",
  NoVotingPower: "На момент знімка цей акаунт не мав активних голосів.",
  AlreadyVoted: "Цей акаунт уже проголосував.",
  VotingClosed: "Голосування завершилося.",
  NotApproved: "Пропозиція ще не схвалена або вже виконана.",
  UnknownProposal: "Пропозицію не знайдено.",
  InsufficientFunds: "У скарбниці бракує вільних ETH.",
  NothingToClaim: "Цьому акаунту поки нічого забирати.",
  PaymentFailed: "Отримувач відхилив переказ. Кошти залишилися зарезервованими.",
  EnforcedPause: "Адміністратор призупинив цю операцію.",
};
const pageSize = 5;
let session;
let page = 0;
let busy = false;
let refreshing = false;
let connecting = false;

function status(message, error = false) {
  $("status").textContent = message;
  $("status").toggleAttribute("data-error", error);
}

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Спочатку розгорніть контракти за інструкцією в README.");
  return response.json();
}

function errorMessage(error) {
  if (error.code === "ACTION_REJECTED" || error.code === 4001) return "Ви скасували запит у гаманці.";
  if (error.code === "INVALID_ARGUMENT") return "Перевірте формат адреси отримувача й суми ETH.";
  if (error.code === "INSUFFICIENT_FUNDS") return "На гаманці бракує ETH для комісії.";
  const rpcMessage = [error.shortMessage, error.message, error.error?.message, error.info?.error?.message,
    error.info?.error?.data?.message, error.info?.error?.data?.originalError?.message].join(" ");
  if (session?.local && (error.code === "NONCE_EXPIRED" || /nonce/i.test(rpcMessage))) {
    return "Hardhat відхилив номер транзакції (nonce). Після перезапуску локальної мережі очистьте дані активності й nonce для Hardhat Local у MetaMask та повторіть дію.";
  }
  if (errors[error.revert?.name]) return errors[error.revert.name];
  for (const contract of session?.contracts ?? []) {
    try {
      const data = error.data ?? error.info?.error?.data;
      const name = contract.interface.parseError(typeof data === "object" ? data.data : data)?.name;
      if (errors[name]) return errors[name];
    } catch { /* The revert may belong to a different contract. */ }
  }
  return "Операція не вдалася. Перевірте мережу, поля форми та стан контрактів.";
}

async function transact(prepare) {
  if (!session || busy) return;
  const current = session;
  busy = true;
  status("Підтвердьте транзакцію в MetaMask…");
  try {
    const overrides = current.local
      ? { nonce: await current.reader.getTransactionCount(current.account, "pending") }
      : {};
    if (current !== session) return;
    const request = await prepare(overrides);
    const hash = await current.signer.sendUncheckedTransaction(request);
    status("Очікує підтвердження мережі…");
    const receipt = await current.reader.waitForTransaction(hash, 1, 120_000);
    if (!receipt || receipt.status !== 1) {
      status(receipt
        ? "Мережа відхилила транзакцію."
        : "Підтвердження ще не надійшло. Перевірте стан транзакції в гаманці.", true);
      return;
    }
    status("Транзакцію підтверджено.");
  } catch (error) {
    console.warn("DAO transaction failed", error);
    status(errorMessage(error), true);
  } finally {
    busy = false;
    await refresh();
  }
}

function text(tag, content) {
  const element = document.createElement(tag);
  element.textContent = content;
  return element;
}

function action(label, run, disabled) {
  const button = text("button", label);
  button.disabled = disabled;
  button.onclick = () => transact(run);
  return button;
}

async function proposalCard(current, id, votingPaused, treasuryPaused) {
  const { voting, token, account } = current;
  const [p, state, voted] = await Promise.all([
    voting.getProposal(id), voting.state(id), voting.hasVoted(id, account),
  ]);
  const voteWeight = state === 0n ? await token.getPastVotes(account, p.snapshot) : 0n;
  const card = document.createElement("article");
  card.append(
    text("h2", "#" + id + " · " + states[Number(state)]),
    text("p", formatEther(p.amount) + " ETH → " + p.recipient),
    text("p", "За " + formatEther(p.votesFor) + " · Проти " + formatEther(p.votesAgainst)),
    text("p", "Дедлайн " + new Date(Number(p.deadline) * 1000).toLocaleString("uk-UA")),
  );
  const actions = document.createElement("nav");
  if (state === 0n) {
    const disabled = votingPaused || voted || voteWeight === 0n;
    card.append(text("p", voted ? "Ваш голос зараховано." : "Ваша вага на знімку · " + formatEther(voteWeight)));
    actions.append(
      action("За", overrides => voting.vote.populateTransaction(id, true, overrides), disabled),
      action("Проти", overrides => voting.vote.populateTransaction(id, false, overrides), disabled),
    );
  }
  if (state === 2n) {
    actions.append(action("Виконати", overrides => voting.execute.populateTransaction(id, overrides), votingPaused || treasuryPaused));
  }
  card.append(actions);
  return card;
}

async function refresh() {
  if (!session || refreshing) return;
  refreshing = true;
  const current = session;
  try {
    const { token, treasury, voting, account } = current;
    const [tokens, power, delegate, available, claimable, quorum, count, votingPaused, treasuryPaused] = await Promise.all([
      token.balanceOf(account), token.getVotes(account), token.delegates(account), treasury.available(),
      treasury.claimable(account), voting.quorum(), voting.proposalCount(), voting.paused(), treasury.paused(),
    ]);
    page = Math.min(page, Math.max(0, Math.ceil(Number(count) / pageSize) - 1));
    const high = Number(count) - page * pageSize;
    const ids = Array.from({ length: Math.min(pageSize, high) }, (_, offset) => high - offset);
    const cards = await Promise.all(ids.map(id => proposalCard(current, id, votingPaused, treasuryPaused)));
    if (current !== session) return;
    for (const [id, value, symbol] of [["tokens", tokens, "VOTE"], ["power", power, "VOTE"],
      ["quorum", quorum, "VOTE"], ["available", available, "ETH"], ["claimable", claimable, "ETH"]]) {
      $(id).textContent = formatEther(value) + " " + symbol;
    }
    $("delegate").disabled = tokens === 0n || delegate === account;
    $("claim").disabled = claimable === 0n || treasuryPaused;
    $("proposal").querySelector("button").disabled = power === 0n || votingPaused;
    $("newer").disabled = page === 0;
    $("older").disabled = high <= pageSize;
    $("proposals").replaceChildren(...(cards.length ? cards : [text("p", "Пропозицій ще немає.")]));
    $("dashboard").hidden = false;
    if ($("status").dataset.readError === "true") status("Гаманець підключено.");
    delete $("status").dataset.readError;
  } catch (error) {
    if (current === session && !busy) {
      $("dashboard").hidden = true;
      status(current.local
        ? "Не вдалося прочитати контракти Hardhat. Перевірте, чи вузол запущено і чи після його запуску виконано npm run deploy:local."
        : "Не вдалося прочитати контракти Sepolia. Перевірте з’єднання з мережею.", true);
      $("status").dataset.readError = "true";
    }
  } finally {
    refreshing = false;
    if (session && current !== session) void refresh();
  }
}

async function connect(interactive) {
  if (connecting) return;
  connecting = true;
  $("connect").disabled = true;
  if (interactive) status("Відкрийте MetaMask і підтвердьте підключення сайту.");

  const previous = session;
  session = undefined;
  $("dashboard").hidden = true;
  if (previous) previous.contracts.forEach(contract => void contract.removeAllListeners());
  try {
    const wallet = window.ethereum;
    if (!wallet) throw new Error("Відкрийте цю адресу в браузері, де встановлено розширення MetaMask.");
    const accounts = await wallet.request({ method: interactive ? "eth_requestAccounts" : "eth_accounts" });
    if (!accounts.length) { status("Підключіть MetaMask, щоб переглянути пропозиції."); return; }
    const provider = new BrowserProvider(wallet);
    const deployment = await json("/deployment.json");
    const { chainId } = await provider.getNetwork();
    if (chainId !== BigInt(deployment.chainId)) {
      throw new Error("У MetaMask виберіть мережу " + deployment.label + " (" + deployment.chainId + ").");
    }
    const signer = await provider.getSigner(accounts[0]);
    const [votingAbi, treasuryAbi, tokenAbi] = await Promise.all(
      ["DaoVoting", "Treasury", "VoteToken"].map(name => json("/" + name + ".json")),
    );
    const local = deployment.chainId === 31337;
    const reader = local ? new JsonRpcProvider("http://127.0.0.1:8545", 31337) : provider;
    const voting = new Contract(deployment.voting, votingAbi.abi, reader);
    const treasury = new Contract(deployment.treasury, treasuryAbi.abi, reader);
    const token = new Contract(deployment.token, tokenAbi.abi, reader);
    const account = await signer.getAddress();
    session = { account, local, reader, signer, token, treasury, voting, contracts: [voting, treasury, token] };
    page = 0;
    $("account").textContent = account;
    $("network").textContent = deployment.label;
    status("Гаманець підключено.");
    for (const [contract, events] of [
      [voting, ["Proposed", "Voted", "Executed", "Paused", "Unpaused"]],
      [treasury, ["Deposited", "Allocated", "Claimed", "Paused", "Unpaused"]],
      [token, ["Transfer", "DelegateVotesChanged"]],
    ]) {
      for (const event of events) void contract.on(event, refresh).catch(() => {});
    }
    await refresh();
  } catch (error) {
    if (error.code === -32002) {
      status("MetaMask уже чекає підтвердження. Відкрийте розширення й підтвердьте або скасуйте відкритий запит.");
    } else {
      status(error.code ? errorMessage(error) : error.message, true);
    }
  } finally {
    connecting = false;
    $("connect").disabled = false;
  }
}

$("connect").onclick = () => connect(true);
$("delegate").onclick = () => transact(overrides => session.token.delegate.populateTransaction(session.account, overrides));
$("claim").onclick = () => transact(overrides => session.treasury.claim.populateTransaction(overrides));
$("newer").onclick = () => { page--; void refresh(); };
$("older").onclick = () => { page++; void refresh(); };
$("proposal").onsubmit = event => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  void transact(overrides => session.voting.propose.populateTransaction(
    getAddress(data.get("recipient").trim()), parseEther(data.get("amount").trim()), overrides,
  ));
};
window.ethereum?.on("accountsChanged", () => { if (!connecting) location.reload(); });
window.ethereum?.on("chainChanged", () => location.reload());
setInterval(refresh, 4000);
void connect(false);
