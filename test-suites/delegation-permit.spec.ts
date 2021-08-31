import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { MAX_UINT_AMOUNT, ZERO_ADDRESS } from '../helpers/constants';
import { BUIDLEREVM_CHAINID } from '../helpers/buidler-constants';
import {
  buildPermitDelegationParams,
  convertToCurrencyDecimals,
  getSignatureFromTypedData,
} from '../helpers/contracts-helpers';
import { DRE, evmRevert, evmSnapshot, timeLatest } from '../helpers/misc-utils';
import { makeSuite, TestEnv } from './helpers/make-suite';
import { getTestWallets } from './helpers/utils/wallets';

makeSuite('DebtToken: Permit Delegation', (testEnv: TestEnv) => {
  let snapId;

  beforeEach(async () => {
    snapId = await evmSnapshot();
  });
  afterEach(async () => {
    await evmRevert(snapId);
  });

  let daiMintedAmount: BigNumber;
  let wethMintedAmount: BigNumber;
  let testWallets;

  const MINT_AMOUNT = '1000';
  const EIP712_REVISION = '1';

  before(async () => {
    const {
      pool,
      weth,
      dai,
      deployer: user1,
      users: [user2],
    } = testEnv;
    testWallets = getTestWallets();

    // Setup the pool
    daiMintedAmount = await convertToCurrencyDecimals(dai.address, MINT_AMOUNT);
    wethMintedAmount = await convertToCurrencyDecimals(weth.address, MINT_AMOUNT);

    expect(await dai.mint(daiMintedAmount));
    expect(await dai.approve(pool.address, daiMintedAmount));
    expect(await pool.deposit(dai.address, daiMintedAmount, user1.address, 0));
    expect(await weth.connect(user2.signer).mint(wethMintedAmount));
    expect(await weth.connect(user2.signer).approve(pool.address, wethMintedAmount));
    expect(
      await pool.connect(user2.signer).deposit(weth.address, wethMintedAmount, user2.address, 0)
    );
  });

  it('Checks the domain separator', async () => {
    const { variableDebtDai, stableDebtDai } = testEnv;
    const variableSeparator = await variableDebtDai.DOMAIN_SEPARATOR();
    const stableSeparator = await stableDebtDai.DOMAIN_SEPARATOR();

    const variableDomain = {
      name: await variableDebtDai.name(),
      version: EIP712_REVISION,
      chainId: DRE.network.config.chainId,
      verifyingContract: variableDebtDai.address,
    };
    const stableDomain = {
      name: await stableDebtDai.name(),
      version: EIP712_REVISION,
      chainId: DRE.network.config.chainId,
      verifyingContract: stableDebtDai.address,
    };
    const variableDomainSeparator = utils._TypedDataEncoder.hashDomain(variableDomain);
    const stableDomainSeparator = utils._TypedDataEncoder.hashDomain(stableDomain);

    expect(variableSeparator).to.be.equal(
      variableDomainSeparator,
      'Invalid variable domain separator'
    );
    expect(stableSeparator).to.be.equal(stableDomainSeparator, 'Invalid stable domain separator');
  });

  it('User 3 borrows variable interest dai on behalf of user 2 via permit', async () => {
    const {
      pool,
      variableDebtDai,
      dai,
      deployer: user1,
      users: [user2, user3],
    } = testEnv;

    const chainId = DRE.network.config.chainId || BUIDLEREVM_CHAINID;
    const expiration = MAX_UINT_AMOUNT;
    const nonce = (await variableDebtDai._nonces(user2.address)).toNumber();
    const permitAmount = daiMintedAmount.div(3);
    const msgParams = buildPermitDelegationParams(
      chainId,
      variableDebtDai.address,
      EIP712_REVISION,
      await variableDebtDai.name(),
      user2.address,
      user3.address,
      nonce,
      expiration,
      permitAmount.toString()
    );

    const user2PrivateKey = testWallets[1].secretKey;
    expect(
      (await variableDebtDai.borrowAllowance(user2.address, user3.address)).toString()
    ).to.be.equal('0');

    const { v, r, s } = getSignatureFromTypedData(user2PrivateKey, msgParams);

    expect(
      await variableDebtDai
        .connect(user1.signer)
        .permitDelegation(user2.address, user3.address, permitAmount, expiration, v, r, s)
    );

    expect(
      (await variableDebtDai.borrowAllowance(user2.address, user3.address)).toString()
    ).to.be.equal(permitAmount);

    await pool.connect(user3.signer).borrow(dai.address, permitAmount, 2, 0, user2.address);
    expect(
      (await variableDebtDai.borrowAllowance(user2.address, user3.address)).toString()
    ).to.be.equal('0');
  });

  it('User 3 borrows stable interest dai on behalf of user 2 via permit', async () => {
    const {
      pool,
      stableDebtDai,
      dai,
      deployer: user1,
      users: [user2, user3],
    } = testEnv;

    const chainId = DRE.network.config.chainId || BUIDLEREVM_CHAINID;
    const expiration = MAX_UINT_AMOUNT;
    const nonce = (await stableDebtDai._nonces(user2.address)).toNumber();
    const permitAmount = daiMintedAmount.div(3);
    const msgParams = buildPermitDelegationParams(
      chainId,
      stableDebtDai.address,
      EIP712_REVISION,
      await stableDebtDai.name(),
      user2.address,
      user3.address,
      nonce,
      expiration,
      permitAmount.toString()
    );

    const user2PrivateKey = testWallets[1].secretKey;
    expect(
      (await stableDebtDai.borrowAllowance(user2.address, user3.address)).toString()
    ).to.be.equal('0');

    const { v, r, s } = getSignatureFromTypedData(user2PrivateKey, msgParams);

    expect(
      await stableDebtDai
        .connect(user1.signer)
        .permitDelegation(user2.address, user3.address, permitAmount, expiration, v, r, s)
    );

    expect(
      (await stableDebtDai.borrowAllowance(user2.address, user3.address)).toString()
    ).to.be.equal(permitAmount);

    await pool
      .connect(user3.signer)
      .borrow(dai.address, daiMintedAmount.div(10), 1, 0, user2.address);

    expect(
      (await stableDebtDai.borrowAllowance(user2.address, user3.address)).toString()
    ).to.be.equal(permitAmount.sub(daiMintedAmount.div(10)));
  });

  it('Stable debt delegation with delegator == address(0)', async () => {
    const {
      stableDebtDai,
      deployer: user1,
      users: [user2, user3],
    } = testEnv;

    const chainId = DRE.network.config.chainId || BUIDLEREVM_CHAINID;
    const expiration = MAX_UINT_AMOUNT;
    const nonce = (await stableDebtDai._nonces(user2.address)).toNumber();
    const EIP712_REVISION = await stableDebtDai.EIP712_REVISION();
    const permitAmount = daiMintedAmount.div(3);
    const msgParams = buildPermitDelegationParams(
      chainId,
      stableDebtDai.address,
      EIP712_REVISION,
      await stableDebtDai.name(),
      ZERO_ADDRESS,
      user3.address,
      nonce,
      expiration,
      permitAmount.toString()
    );

    const user2PrivateKey = testWallets[1].secretKey;
    expect(
      (await stableDebtDai.borrowAllowance(user2.address, user3.address)).toString()
    ).to.be.equal('0');

    const { v, r, s } = getSignatureFromTypedData(user2PrivateKey, msgParams);

    await expect(
      stableDebtDai
        .connect(user1.signer)
        .permitDelegation(ZERO_ADDRESS, user3.address, permitAmount, expiration, v, r, s)
    ).to.be.revertedWith('INVALID_DELEGATOR');

    expect(
      (await stableDebtDai.borrowAllowance(user2.address, user3.address)).toString()
    ).to.be.equal('0');
  });

  it('Stable debt delegation with block.timestamp > deadline', async () => {
    const {
      stableDebtDai,
      deployer: user1,
      users: [user2, user3],
    } = testEnv;

    const chainId = DRE.network.config.chainId || BUIDLEREVM_CHAINID;
    const expiration = (await timeLatest()).sub(500).toString();
    const nonce = (await stableDebtDai._nonces(user2.address)).toNumber();
    const permitAmount = daiMintedAmount.div(3);
    const msgParams = buildPermitDelegationParams(
      chainId,
      stableDebtDai.address,
      EIP712_REVISION,
      await stableDebtDai.name(),
      user2.address,
      user3.address,
      nonce,
      expiration,
      permitAmount.toString()
    );

    const user2PrivateKey = testWallets[1].secretKey;
    expect(
      (await stableDebtDai.borrowAllowance(user2.address, user3.address)).toString()
    ).to.be.equal('0');

    const { v, r, s } = getSignatureFromTypedData(user2PrivateKey, msgParams);

    await expect(
      stableDebtDai
        .connect(user1.signer)
        .permitDelegation(user2.address, user3.address, permitAmount, expiration, v, r, s)
    ).to.be.revertedWith('INVALID_EXPIRATION');

    expect(
      (await stableDebtDai.borrowAllowance(user2.address, user3.address)).toString()
    ).to.be.equal('0');
  });

  it('Stable debt delegation with invalid delegator signature', async () => {
    const {
      stableDebtDai,
      deployer: user1,
      users: [user2, user3],
    } = testEnv;

    const chainId = DRE.network.config.chainId || BUIDLEREVM_CHAINID;
    const expiration = MAX_UINT_AMOUNT;
    const nonce = (await stableDebtDai._nonces(user2.address)).toNumber();
    const permitAmount = daiMintedAmount.div(3);
    const msgParams = buildPermitDelegationParams(
      chainId,
      stableDebtDai.address,
      EIP712_REVISION,
      await stableDebtDai.name(),
      ZERO_ADDRESS,
      user3.address,
      nonce,
      expiration,
      permitAmount.toString()
    );

    const user2PrivateKey = testWallets[1].secretKey;
    expect(
      (await stableDebtDai.borrowAllowance(user2.address, user3.address)).toString()
    ).to.be.equal('0');

    const { v, r, s } = getSignatureFromTypedData(user2PrivateKey, msgParams);

    await expect(
      stableDebtDai
        .connect(user1.signer)
        .permitDelegation(user2.address, user3.address, permitAmount, expiration, v, r, s)
    ).to.be.revertedWith('INVALID_SIGNATURE');

    expect(
      (await stableDebtDai.borrowAllowance(user2.address, user3.address)).toString()
    ).to.be.equal('0');
  });

  it('Variable debt delegation with delegator == address(0)', async () => {
    const {
      variableDebtDai,
      deployer: user1,
      users: [user2, user3],
    } = testEnv;

    const chainId = DRE.network.config.chainId || BUIDLEREVM_CHAINID;
    const expiration = MAX_UINT_AMOUNT;
    const nonce = (await variableDebtDai._nonces(user2.address)).toNumber();
    const permitAmount = daiMintedAmount.div(3);
    const msgParams = buildPermitDelegationParams(
      chainId,
      variableDebtDai.address,
      EIP712_REVISION,
      await variableDebtDai.name(),
      ZERO_ADDRESS,
      user3.address,
      nonce,
      expiration,
      permitAmount.toString()
    );

    const user2PrivateKey = testWallets[1].secretKey;
    expect(
      (await variableDebtDai.borrowAllowance(user2.address, user3.address)).toString()
    ).to.be.equal('0');

    const { v, r, s } = getSignatureFromTypedData(user2PrivateKey, msgParams);

    await expect(
      variableDebtDai
        .connect(user1.signer)
        .permitDelegation(ZERO_ADDRESS, user3.address, permitAmount, expiration, v, r, s)
    ).to.be.revertedWith('INVALID_DELEGATOR');

    expect(
      (await variableDebtDai.borrowAllowance(user2.address, user3.address)).toString()
    ).to.be.equal('0');
  });

  it('Variable debt delegation with block.timestamp > deadline', async () => {
    const {
      variableDebtDai,
      deployer: user1,
      users: [user2, user3],
    } = testEnv;

    const chainId = DRE.network.config.chainId || BUIDLEREVM_CHAINID;
    const expiration = (await timeLatest()).sub(500).toString();
    const nonce = (await variableDebtDai._nonces(user2.address)).toNumber();
    const permitAmount = daiMintedAmount.div(3);
    const msgParams = buildPermitDelegationParams(
      chainId,
      variableDebtDai.address,
      EIP712_REVISION,
      await variableDebtDai.name(),
      user2.address,
      user3.address,
      nonce,
      expiration,
      permitAmount.toString()
    );

    const user2PrivateKey = testWallets[1].secretKey;
    expect(
      (await variableDebtDai.borrowAllowance(user2.address, user3.address)).toString()
    ).to.be.equal('0');

    const { v, r, s } = getSignatureFromTypedData(user2PrivateKey, msgParams);

    await expect(
      variableDebtDai
        .connect(user1.signer)
        .permitDelegation(user2.address, user3.address, permitAmount, expiration, v, r, s)
    ).to.be.revertedWith('INVALID_EXPIRATION');

    expect(
      (await variableDebtDai.borrowAllowance(user2.address, user3.address)).toString()
    ).to.be.equal('0');
  });

  it('Variable debt delegation with invalid delegator signature', async () => {
    const {
      variableDebtDai,
      deployer: user1,
      users: [user2, user3],
    } = testEnv;

    const chainId = DRE.network.config.chainId || BUIDLEREVM_CHAINID;
    const expiration = MAX_UINT_AMOUNT;
    const nonce = (await variableDebtDai._nonces(user2.address)).toNumber();
    const permitAmount = daiMintedAmount.div(3);
    const msgParams = buildPermitDelegationParams(
      chainId,
      variableDebtDai.address,
      EIP712_REVISION,
      await variableDebtDai.name(),
      ZERO_ADDRESS,
      user3.address,
      nonce,
      expiration,
      permitAmount.toString()
    );

    const user2PrivateKey = testWallets[1].secretKey;
    expect(
      (await variableDebtDai.borrowAllowance(user2.address, user3.address)).toString()
    ).to.be.equal('0');

    const { v, r, s } = getSignatureFromTypedData(user2PrivateKey, msgParams);

    await expect(
      variableDebtDai
        .connect(user1.signer)
        .permitDelegation(user2.address, user3.address, permitAmount, expiration, v, r, s)
    ).to.be.revertedWith('INVALID_SIGNATURE');

    expect(
      (await variableDebtDai.borrowAllowance(user2.address, user3.address)).toString()
    ).to.be.equal('0');
  });
});
