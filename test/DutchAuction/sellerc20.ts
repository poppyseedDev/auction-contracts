import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import type { DutchAuctionSellingERC20, MockERC20 } from "../../types";

describe("DutchAuctionSellingERC20", function () {
  let auction: DutchAuctionSellingERC20, token: MockERC20, seller: SignerWithAddress, buyer: SignerWithAddress;

  const startingPrice = ethers.parseEther("0.0001");
  const reservePrice = ethers.parseEther("0.00001");
  const discountRate = ethers.parseUnits("10", "wei");
  const tokenAmount = 10n;

  beforeEach(async function () {
    [seller, buyer] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    token = await Token.deploy("Mock Token", "MTK", seller.address, tokenAmount);
    await token.waitForDeployment();
    // Mint tokens to seller
    const mintTx = await token.connect(seller).mint(seller.address, tokenAmount);
    await mintTx.wait();

    const DutchAuction = await ethers.getContractFactory("DutchAuctionSellingERC20");
    auction = await DutchAuction.deploy(startingPrice, discountRate, token.getAddress(), tokenAmount, reservePrice);
    await auction.waitForDeployment();
  });

  it("should deploy correctly", async function () {
    expect(await auction.token()).to.equal(await token.getAddress());
    expect(await auction.amount()).to.equal(tokenAmount);
    expect(await auction.startingPrice()).to.equal(startingPrice);
  });

  it("should return the correct price over time", async function () {
    const price1 = await auction.getPrice();
    expect(price1).to.equal(startingPrice);

    await ethers.provider.send("evm_increaseTime", [3600]); // Advance 1 hour
    await ethers.provider.send("evm_mine");
    const price2 = await auction.getPrice();
    expect(price2).to.be.lt(startingPrice);
  });

  it("should allow a buyer to purchase the tokens", async function () {
    // Log initial balance
    const buyerInitialBalance = await ethers.provider.getBalance(buyer.address);
    console.log("Initial buyer balance:", buyerInitialBalance);
    const tolerance = ethers.parseUnits("100", "wei"); // 10 wei tolerance

    await token.connect(seller).approve(auction.getAddress(), tokenAmount);
    const price = await auction.getPrice();
    const totalPrice = price * tokenAmount;

    console.log("Price per token:", price);
    console.log("Token amount:", tokenAmount);
    console.log("Total price calculated:", totalPrice);
    console.log("Buyer balance before purchase:", await ethers.provider.getBalance(buyer.address));

    const tx = await auction.connect(buyer).buy(tokenAmount, { value: totalPrice });
    const receipt = await tx.wait();

    // Calculate gas costs
    const gasCost = receipt.gasUsed * receipt.gasPrice;

    const buyerFinalBalance = await ethers.provider.getBalance(buyer.address);
    const actualChange = buyerInitialBalance - buyerFinalBalance;

    expect(actualChange).to.be.closeTo(totalPrice + gasCost, tolerance);
  });

  it("should revert if the auction has ended", async function () {
    await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60]); // Advance 7 days
    await ethers.provider.send("evm_mine");

    await expect(auction.connect(buyer).buy(tokenAmount, { value: startingPrice })).to.be.revertedWith(
      "This auction has ended",
    );
  });
});
